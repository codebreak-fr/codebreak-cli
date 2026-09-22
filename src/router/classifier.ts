import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { classifierCachePath } from '../config/paths.js';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import { CATEGORIES, type TaskFeatures } from '../types.js';
import { parseRateLimitEvent, saveUsage } from '../usage/claude.js';
import { exec } from '../util/exec.js';
import { readJson, writeJson } from '../util/store.js';

export interface RouterModel {
  provider: 'ollama' | 'opencode' | 'claude';
  model: string;
  label: string;
}

/** Plus petit modèle Ollama utilisable pour classer (≤ ~4B de préférence). */
export function pickRouterModel(det: Detection, cfg: Config): RouterModel | null {
  const { provider, model } = cfg.router;
  if (provider === 'rules' || cfg.router.mode === 'never') return null;

  const ollamaModels = det.ollama.models.filter((m) => m.capabilities.includes('completion') && m.fits);
  const smallestOllama = () => [...ollamaModels].sort((a, b) => (a.paramsB ?? a.sizeGB) - (b.paramsB ?? b.sizeGB))[0];
  const firstFree = () => det.opencode.freeModels.find((m) => cfg.opencode.preferred.some((p) => m.endsWith(p))) ?? det.opencode.freeModels[0];

  const explicit = (p: RouterModel['provider']): RouterModel | null => {
    if (p === 'ollama') {
      // un outil décoché dans /tools ne doit jamais être appelé, même comme routeur
      if (!cfg.ollama.enabled) return null;
      const m = model === 'auto' ? smallestOllama()?.name : model;
      return m && det.ollama.installed ? { provider: p, model: m, label: `ollama/${m}` } : null;
    }
    if (p === 'opencode') {
      if (!cfg.opencode.enabled) return null;
      const m = model === 'auto' ? firstFree() : model;
      return m && det.opencode.installed ? { provider: p, model: m, label: m } : null;
    }
    if (!cfg.claude.enabled) return null;
    const m = model === 'auto' ? 'haiku' : model;
    return det.claude.installed && det.claude.ready ? { provider: p, model: m, label: `claude/${m}` } : null;
  };

  if (provider !== 'auto') return explicit(provider);
  return explicit('ollama') ?? explicit('opencode') ?? explicit('claude');
}

const LlmOut = z.object({
  complexity: z.coerce.number().int().min(1).max(5),
  category: z.string(),
  needs_edit: z.boolean().optional(),
  needs_repo: z.boolean().optional(),
  needs_mcp: z.boolean().optional(),
  security: z.boolean().optional(),
  context: z.enum(['small', 'medium', 'large']).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    complexity: { type: 'integer', minimum: 1, maximum: 5 },
    category: { type: 'string', enum: [...CATEGORIES] },
    needs_edit: { type: 'boolean' },
    needs_repo: { type: 'boolean' },
    needs_mcp: { type: 'boolean' },
    security: { type: 'boolean' },
    context: { type: 'string', enum: ['small', 'medium', 'large'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['complexity', 'category', 'needs_edit', 'security', 'confidence', 'reason'],
};

const SYSTEM = `Tu es un routeur de tâches de développement logiciel. Analyse la demande et réponds UNIQUEMENT par un objet JSON.
complexity : 1 = trivial (renommer, typo, format, commentaire, question simple) ; 2 = petite tâche locale (un test, un petit composant, un script) ; 3 = moyenne (fonctionnalité sur quelques fichiers, bug courant) ; 4 = difficile (multi-fichiers, intégration, débogage délicat) ; 5 = critique (architecture, refonte, faille de sécurité, bug très difficile).
category : ${CATEGORIES.join(' | ')}.
needs_edit : la demande modifie des fichiers. needs_repo : elle doit lire le code du projet. needs_mcp : elle utilise un outil externe (Figma, Notion…). security : elle touche auth, secrets, paiements, données personnelles.
context : small | medium | large. confidence : 0 à 1. reason : une phrase courte.`;

/** Indice de stack du projet (nom + technologies clés) pour orienter le classifieur. */
export function projectHint(cwd: string): string {
  const pkgPath = join(cwd, 'package.json');
  const parts = [basename(cwd)];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      const known = ['react', 'vite', 'next', 'hono', 'express', 'drizzle-orm', 'better-auth', 'stripe', 'typescript', 'playwright', 'tailwindcss'];
      parts.push(...known.filter((k) => deps.includes(k)));
    } catch {
      /* package.json illisible */
    }
  } else if (existsSync(join(cwd, 'pyproject.toml'))) parts.push('python');
  return parts.join(', ');
}

const cacheKey = (prompt: string, model: string, hint: string) =>
  createHash('sha1').update(`${model}|${hint}|${prompt.trim().toLowerCase()}`).digest('hex');

interface CacheFile {
  [key: string]: { ts: number; features: Partial<TaskFeatures> };
}

function toFeatures(o: z.infer<typeof LlmOut>): Partial<TaskFeatures> {
  const category = (CATEGORIES as readonly string[]).includes(o.category) ? (o.category as TaskFeatures['category']) : undefined;
  return {
    complexity: o.complexity as TaskFeatures['complexity'],
    category,
    needsEdit: o.needs_edit,
    needsRepo: o.needs_repo,
    needsMcp: o.needs_mcp,
    security: o.security,
    contextSize: o.context,
    confidence: o.confidence,
    reason: o.reason,
    source: 'llm',
  };
}

export function parseLlmJson(text: string): Partial<TaskFeatures> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const parsed = LlmOut.safeParse(JSON.parse(m[0]));
    return parsed.success ? toFeatures(parsed.data) : null;
  } catch {
    return null;
  }
}

async function viaOllama(rm: RouterModel, user: string, cfg: Config): Promise<string | null> {
  try {
    const r = await fetch(`${cfg.ollama.base_url}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(cfg.router.timeout_ms),
      body: JSON.stringify({
        model: rm.model,
        stream: false,
        keep_alive: cfg.ollama.keep_alive,
        format: JSON_SCHEMA,
        options: { temperature: 0, num_ctx: 4096, num_predict: 220 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { message?: { content?: string } }).message?.content ?? null;
  } catch {
    return null;
  }
}

async function viaOpencode(rm: RouterModel, user: string, cfg: Config, det: Detection): Promise<string | null> {
  if (!det.opencode.path) return null;
  const r = await exec(det.opencode.path, ['run', '-m', rm.model, '--format', 'json', `${SYSTEM}\n\n${user}`], {
    timeoutMs: cfg.router.timeout_ms,
  });
  let text = '';
  for (const line of r.stdout.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'text') text += ev.part?.text ?? '';
    } catch {
      /* ligne de log */
    }
  }
  return text || null;
}

async function viaClaude(rm: RouterModel, user: string, cfg: Config, det: Detection): Promise<string | null> {
  if (!det.claude.path) return null;
  const r = await exec(
    det.claude.path,
    [
      '-p', user, '--model', rm.model, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt', SYSTEM,
      '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
    ],
    { timeoutMs: cfg.router.timeout_ms },
  );
  let text = '';
  for (const line of r.stdout.split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'rate_limit_event') {
        const patch = parseRateLimitEvent(ev);
        if (patch) saveUsage(patch);
      }
      if (ev.type === 'result' && typeof ev.result === 'string') text = ev.result;
    } catch {
      /* ligne partielle */
    }
  }
  return text || null;
}

export interface ClassifyResult {
  features: Partial<TaskFeatures>;
  ms: number;
  model: string;
  cached: boolean;
}

export async function classifyWithLlm(
  prompt: string,
  cwd: string,
  cfg: Config,
  det: Detection,
  rm: RouterModel,
): Promise<ClassifyResult | null> {
  const started = Date.now();
  const hint = projectHint(cwd);
  const key = cacheKey(prompt, rm.label, hint);
  const cache = readJson<CacheFile>(classifierCachePath(), {});
  const ttl = cfg.router.cache_ttl_hours * 3_600_000;
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < ttl) {
    return { features: hit.features, ms: Date.now() - started, model: rm.label, cached: true };
  }

  const user = `Projet : ${hint}\nDemande : ${prompt.slice(0, 1500)}`;
  const raw =
    rm.provider === 'ollama'
      ? await viaOllama(rm, user, cfg)
      : rm.provider === 'opencode'
        ? await viaOpencode(rm, user, cfg, det)
        : await viaClaude(rm, user, cfg, det);
  const features = raw ? parseLlmJson(raw) : null;
  if (!features) return null;

  cache[key] = { ts: Date.now(), features };
  const entries = Object.entries(cache);
  if (entries.length > 500) {
    entries.sort((a, b) => b[1].ts - a[1].ts);
    writeJson(classifierCachePath(), Object.fromEntries(entries.slice(0, 400)));
  } else {
    writeJson(classifierCachePath(), cache);
  }
  return { features, ms: Date.now() - started, model: rm.label, cached: false };
}

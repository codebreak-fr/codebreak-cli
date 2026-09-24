import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from '../../util/exec.js';
import { activeIncident } from '../incidents.js';
import { unknownMetric, type ServiceStatus, type ServiceUsage, type UsageContext, type UsageMetric, type UsageProvider } from '../types.js';

/**
 * Outils cloud dont CodeBreak ne peut PAS lire un quota de façon fiable : on rapporte ce qui est réellement observable
 * (installé ? connecté ? incidents récents ?) et `unknown` pour le reste, avec la raison.
 */

interface ToolSpec {
  id: string;
  label: string;
  installed(ctx: UsageContext): { installed: boolean; ready: boolean; detail: string };
  /** pourquoi le quota n'est pas lisible */
  why: string;
  extra?(ctx: UsageContext): Promise<UsageMetric[]> | UsageMetric[];
}

function build(spec: ToolSpec): UsageProvider {
  return {
    id: spec.id,
    label: spec.label,
    kind: 'cloud',
    async collect(ctx): Promise<ServiceUsage> {
      const base = { service: spec.id, label: spec.label, kind: 'cloud' as const };
      const d = spec.installed(ctx);
      if (!d.installed) return { ...base, status: 'unavailable', statusSource: 'observed', statusNote: `${spec.label} not installed`, metrics: [] };
      const metrics: UsageMetric[] = [unknownMetric(spec.id, 'quota', spec.why), ...(spec.extra ? await spec.extra(ctx) : [])];
      const incident = activeIncident(spec.id, ctx.now);
      if (incident) {
        metrics.push({ service: spec.id, metric: 'last_incident', value: incident.kind, unit: 'text', source: 'observed', origin: 'agent error', observedAt: incident.at, resetAt: incident.resetAt, confidence: 'high', note: incident.message });
        return { ...base, status: incident.kind === 'auth' ? 'auth_error' : 'exhausted', statusSource: 'observed', statusNote: `${incident.kind} incident`, metrics };
      }
      if (!d.ready) return { ...base, status: 'unavailable', statusSource: 'observed', statusNote: d.detail, metrics };
      // installé et prêt : disponible d'après la détection ; la consommation reste inconnue
      return { ...base, status: 'available', statusSource: 'observed', statusNote: 'usage unknown', metrics };
    },
  };
}

const NUMS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
export const parseCompact = (s: string): number | null => {
  const m = /^\$?([\d,.]+)\s*([KMB])?$/i.exec(s.trim());
  return m ? Number(m[1]!.replace(/,/g, '')) * (NUMS[(m[2] ?? '').toUpperCase()] ?? 1) : null;
};

/** Extrait Input / Output / Total Cost du tableau de `opencode stats`. */
export function parseOpencodeStats(text: string): { input?: number; output?: number; cost?: number; sessions?: number } {
  const grab = (label: string) => {
    const m = new RegExp(`${label}\\s+([\\$\\d.,]+[KMB]?)\\s*│`, 'i').exec(text);
    return m ? parseCompact(m[1]!) ?? undefined : undefined;
  };
  return { input: grab('Input'), output: grab('Output'), cost: grab('Total Cost'), sessions: grab('Sessions') };
}

const cache = new Map<string, { at: number; text: string }>();

export const opencodeProvider = build({
  id: 'opencode',
  label: 'OpenCode',
  installed: (ctx) => ({ installed: ctx.det.opencode.installed, ready: ctx.det.opencode.ready, detail: ctx.det.opencode.detail }),
  why: 'free models: no published or observable quota (429s are recorded when they happen)',
  async extra(ctx) {
    const bin = ctx.det.opencode.path;
    if (!bin) return [];
    const hit = cache.get(bin);
    let text = hit && !ctx.refresh && ctx.now - hit.at < ctx.cfg.usage.ttl_minutes * 60_000 ? hit.text : '';
    if (!text) {
      const r = await exec(bin, ['stats', '--days', '1'], { timeoutMs: 8000 });
      if (r.code !== 0) return [unknownMetric('opencode', 'tokens_today', 'opencode stats failed', 'tokens')];
      text = r.stdout;
      cache.set(bin, { at: ctx.now, text });
    }
    const s = parseOpencodeStats(text);
    const base = { service: 'opencode', source: 'observed' as const, origin: 'opencode stats --days 1', observedAt: ctx.now, confidence: 'high' as const };
    const out: UsageMetric[] = [];
    if (s.input !== undefined || s.output !== undefined) out.push({ ...base, metric: 'tokens_today', value: (s.input ?? 0) + (s.output ?? 0), unit: 'tokens' });
    if (s.cost !== undefined) out.push({ ...base, metric: 'cost_today_usd', value: s.cost, unit: 'usd' });
    return out;
  },
});

export const geminiProvider = build({
  id: 'gemini',
  label: 'Gemini CLI',
  installed: (ctx) => ({ installed: ctx.det.gemini.installed, ready: ctx.det.gemini.ready, detail: ctx.det.gemini.detail }),
  why: 'Gemini CLI only shows usage in its interactive /stats; nothing readable from a script (429 / RESOURCE_EXHAUSTED are recorded)',
  extra(ctx) {
    try {
      const settings = JSON.parse(readFileSync(join(ctx.home, '.gemini', 'settings.json'), 'utf8'));
      const type = settings?.security?.auth?.selectedType;
      if (type) return [{ service: 'gemini', metric: 'auth_type', value: String(type), unit: 'text', source: 'observed', origin: '~/.gemini/settings.json', observedAt: ctx.now, confidence: 'high', note: type === 'gemini-api-key' ? 'limits depend on your API key/project quota' : undefined } as UsageMetric];
    } catch {
      /* pas de réglages */
    }
    return [];
  },
});

export const copilotProvider = build({
  id: 'copilot',
  label: 'GitHub Copilot',
  installed: (ctx) => ({ installed: ctx.det.copilot.installed, ready: ctx.det.copilot.ready, detail: ctx.det.copilot.detail }),
  why: 'GitHub Copilot exposes no local or documented usage interface for chat/agent requests',
});

export const vibeProvider = build({
  id: 'vibe',
  label: 'Mistral Vibe',
  installed: (ctx) => ({ installed: ctx.det.vibe.installed, ready: ctx.det.vibe.ready, detail: ctx.det.vibe.detail }),
  why: 'no usage command; a paid subscription is required (402 is recorded)',
});

export const aiderProvider = build({
  id: 'aider',
  label: 'aider',
  installed: (ctx) => ({ installed: ctx.det.aider.installed, ready: ctx.det.aider.ready, detail: ctx.det.aider.detail }),
  why: 'aider uses your own provider keys: limits belong to that provider',
});

// ---- Codex (OpenAI) : fenêtres lues dans les journaux de session locaux qu'il écrit lui-même ----

const tailBytes = (path: string, n = 300_000): string => {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(size, n);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
};

const newestJsonl = (dir: string): string | undefined => {
  let best: { p: string; t: number } | undefined;
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 5) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const t = statSync(p).mtimeMs;
        if (!best || t > best.t) best = { p, t };
      }
    }
  };
  walk(dir, 0);
  return best?.p;
};

export interface CodexWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

/**
 * Dernier `rate_limits` d'un journal Codex (événements `token_count`). Format non documenté officiellement :
 * lecture tolérante, confiance moyenne.
 */
export function parseCodexRateLimits(jsonl: string, now: number): { windows: CodexWindow[]; observedAt?: number } | null {
  const lines = jsonl.split('\n').filter((l) => l.includes('rate_limits'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]!);
      const rl = ev?.payload?.rate_limits ?? ev?.rate_limits;
      if (!rl) continue;
      const windows: CodexWindow[] = [];
      for (const key of ['primary', 'secondary']) {
        const w = rl[key];
        if (!w || typeof w.used_percent !== 'number') continue;
        const inSec = typeof w.resets_in_seconds === 'number' ? w.resets_in_seconds : undefined;
        const at = ev.timestamp ? Date.parse(ev.timestamp) : now;
        windows.push({
          usedPercent: w.used_percent,
          windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
          resetsAt: typeof w.resets_at === 'number' ? w.resets_at * (w.resets_at < 1e12 ? 1000 : 1) : inSec !== undefined ? at + inSec * 1000 : undefined,
        });
      }
      if (windows.length) return { windows, observedAt: ev.timestamp ? Date.parse(ev.timestamp) : undefined };
    } catch {
      /* ligne partielle */
    }
  }
  return null;
}

export const codexProvider: UsageProvider & { applicable(ctx: UsageContext): boolean } = {
  id: 'codex',
  label: 'OpenAI Codex',
  kind: 'cloud',
  applicable: (ctx) => existsSync(join(ctx.env.CODEX_HOME ?? join(ctx.home, '.codex'), 'sessions')),
  async collect(ctx): Promise<ServiceUsage> {
    const base = { service: 'codex', label: 'OpenAI Codex', kind: 'cloud' as const };
    const dir = join(ctx.env.CODEX_HOME ?? join(ctx.home, '.codex'), 'sessions');
    const file = existsSync(dir) ? newestJsonl(dir) : undefined;
    const parsed = file ? parseCodexRateLimits(tailBytes(file), ctx.now) : null;
    if (!parsed) return { ...base, status: 'unknown', statusSource: 'unknown', statusNote: 'no rate-limit event in the local session logs yet', metrics: [unknownMetric('codex', 'quota', 'no rate_limits found in ~/.codex/sessions')] };
    const metrics: UsageMetric[] = parsed.windows.map((w) => {
      const tag = w.windowMinutes === 300 ? 'window_5h' : w.windowMinutes === 10080 ? 'window_7d' : `window_${w.windowMinutes ?? '?'}m`;
      const resetAt = w.resetsAt;
      const expired = resetAt !== undefined && resetAt < ctx.now;
      return { service: 'codex', metric: tag, value: expired ? 0 : w.usedPercent / 100, unit: 'ratio' as const, source: expired ? ('estimated' as const) : ('observed' as const), origin: '~/.codex/sessions (token_count.rate_limits)', observedAt: parsed.observedAt ?? null, resetAt, confidence: expired ? ('medium' as const) : ('medium' as const), note: 'log format is not officially documented' };
    });
    const max = Math.max(...metrics.map((m) => m.value as number));
    const status: ServiceStatus = max >= ctx.cfg.quota.claude.stop ? 'exhausted' : max >= ctx.cfg.quota.claude.hard ? 'limited' : 'available';
    return { ...base, status, statusSource: 'observed', metrics };
  },
};

export const CLOUD_PROVIDERS: UsageProvider[] = [opencodeProvider, geminiProvider, copilotProvider, vibeProvider, aiderProvider];

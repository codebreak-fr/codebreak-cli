import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec, sleep, which } from '../util/exec.js';
import { ensureOllamaRunning } from './ollama-server.js';
import type { Config } from '../config/schema.js';
import type {
  AiderInfo,
  ClaudeInfo,
  CopilotInfo,
  GeminiInfo,
  HardwareInfo,
  HuggingfaceInfo,
  LlamacppInfo,
  LmsInfo,
  LocalModel,
  OllamaInfo,
  OllamaModel,
  OpencodeInfo,
  OtherCli,
  VibeInfo,
} from './types.js';
import { t } from '../i18n/index.js';

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? '';
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function detectClaude(): Promise<ClaudeInfo> {
  const path = which('claude');
  if (!path) return { installed: false, ready: false, detail: t('Claude Code introuvable dans le PATH') };
  const [ver, auth] = await Promise.all([
    exec(path, ['--version'], { timeoutMs: 5000 }),
    exec(path, ['auth', 'status'], { timeoutMs: 8000 }),
  ]);
  let loggedIn = false;
  let authMethod: string | undefined;
  let email: string | undefined;
  try {
    const j = JSON.parse(auth.stdout);
    loggedIn = Boolean(j.loggedIn);
    authMethod = j.authMethod;
    email = j.email;
  } catch {
    /* ancienne version : on suppose connecté */
    loggedIn = auth.code === 0;
  }
  return {
    installed: true,
    path,
    version: firstLine(ver.stdout).replace(/\s*\(Claude Code\)/, ''),
    ready: loggedIn,
    authMethod,
    email,
    detail: loggedIn ? t('connecté ({v})', { v: authMethod ?? 'compte' }) : t('non connecté — lance `claude auth login`'),
  };
}

export async function detectOpencode(): Promise<OpencodeInfo> {
  const path = which('opencode');
  if (!path) {
    return { installed: false, ready: false, detail: t('OpenCode introuvable'), freeModels: [], allModels: [] };
  }
  const [ver, models] = await Promise.all([
    exec(path, ['--version'], { timeoutMs: 5000 }),
    exec(path, ['models'], { timeoutMs: 15000 }),
  ]);
  const all = models.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/\S+$/.test(l));
  const free = all.filter((m) => m.startsWith('opencode/'));
  return {
    installed: true,
    path,
    version: firstLine(ver.stdout),
    ready: free.length > 0,
    freeModels: free,
    allModels: all,
    detail: free.length ? t('{length} modèles gratuits (OpenCode Zen)', { length: free.length }) : t('aucun modèle gratuit détecté'),
  };
}

interface TagModel {
  name: string;
  size: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

async function getJson<T>(url: string, timeoutMs = 3000, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const VARIANT_PREFIX = 'codebreak-';

export async function detectOllama(cfg: Config, hw: HardwareInfo): Promise<OllamaInfo> {
  const baseUrl = cfg.ollama.base_url;
  const path = which('ollama');
  if (!path) {
    return { installed: false, ready: false, running: false, baseUrl, models: [], detail: t('Ollama introuvable') };
  }
  const ver = await exec(path, ['--version'], { timeoutMs: 5000 });
  const version = /(\d+\.\d+\.\d+)/.exec(ver.stdout + ver.stderr)?.[1];
  let autostarted = false;
  let v = await getJson<{ version: string }>(`${baseUrl}/api/version`, 1500);
  if (!v && cfg.ollama.autostart && (await ensureOllamaRunning(cfg, path))) {
    autostarted = true;
    v = await getJson<{ version: string }>(`${baseUrl}/api/version`, 1500);
  }
  if (!v) {
    return {
      installed: true,
      path,
      version,
      ready: false,
      running: false,
      baseUrl,
      models: [],
      detail: t('installé mais arrêté (impossible de le démarrer : `ollama serve`)'),
    };
  }
  const [tags, ps] = await Promise.all([
    getJson<{ models: TagModel[] }>(`${baseUrl}/api/tags`),
    getJson<{ models: { name: string }[] }>(`${baseUrl}/api/ps`),
  ]);
  const loaded = new Set((ps?.models ?? []).map((m) => m.name));
  const visible = (tags?.models ?? []).filter((m) => !m.name.startsWith(VARIANT_PREFIX));
  const models: OllamaModel[] = await Promise.all(
    visible.map(async (m) => {
      const show = await getJson<{ capabilities?: string[]; model_info?: Record<string, unknown> }>(
        `${baseUrl}/api/show`,
        4000,
        { method: 'POST', body: JSON.stringify({ model: m.name }) },
      );
      const ctxKey = Object.keys(show?.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const sizeGB = m.size / 1024 ** 3;
      const paramsB = Number.parseFloat(m.details?.parameter_size ?? '') || undefined;
      return {
        name: m.name,
        sizeGB: Math.round(sizeGB * 10) / 10,
        paramsB,
        quantization: m.details?.quantization_level,
        capabilities: show?.capabilities ?? ['completion'],
        contextLength: ctxKey ? Number(show?.model_info?.[ctxKey]) : undefined,
        fits: sizeGB <= hw.localBudgetGB,
        loaded: loaded.has(m.name),
      };
    }),
  );
  const usable = models.filter((m) => m.capabilities.includes('completion'));
  return {
    installed: true,
    path,
    version,
    ready: usable.length > 0,
    running: true,
    baseUrl,
    models,
    detail: usable.length
      ? t('{length} modèle(s) local(aux){v}', { length: usable.length, v: autostarted ? t(' · serveur démarré automatiquement') : '' })
      : t('aucun modèle — `ollama pull ministral-3:3b`'),
  };
}

export async function detectCopilot(): Promise<CopilotInfo> {
  const path = which('code');
  const standaloneCli = which('copilot') ?? undefined;
  if (!path) {
    return {
      installed: false,
      ready: false,
      chatSupported: false,
      extensionInstalled: false,
      standaloneCli,
      detail: t('commande `code` introuvable (VS Code › Shell Command: Install)'),
    };
  }
  const [ver, help, ext] = await Promise.all([
    exec(path, ['--version'], { timeoutMs: 8000 }),
    exec(path, ['chat', '--help'], { timeoutMs: 8000 }),
    exec(path, ['--list-extensions'], { timeoutMs: 8000 }),
  ]);
  const chatSupported = /Usage: code chat/i.test(help.stdout + help.stderr);
  const extensionInstalled = /github\.copilot/i.test(ext.stdout);
  return {
    installed: true,
    path,
    version: firstLine(ver.stdout),
    chatSupported,
    extensionInstalled,
    standaloneCli,
    // Copilot Chat est intégré à VS Code récent : `code chat` suffit
    ready: chatSupported,
    detail: chatSupported
      ? t('VS Code {v} · code chat disponible', { v: firstLine(ver.stdout) })
      : t('VS Code trop ancien (pas de `code chat`)'),
  };
}

/** Mistral Vibe : agent en terminal, mode programmatique `vibe -p … --output streaming`. */
export async function detectVibe(): Promise<VibeInfo> {
  const path = which('vibe');
  if (!path) return { installed: false, ready: false, detail: t('Vibe introuvable dans le PATH') };
  const ver = await exec(path, ['--version'], { timeoutMs: 5000 });
  const version = firstLine(ver.stdout) || undefined;
  // installé = routable ; une clé absente ou un quota épuisé est signalé à l’exécution
  return { installed: true, path, version, ready: true, detail: `agent Mistral Vibe${version ? ` ${version}` : ''} (${path})` };
}

/** Gemini CLI : mode headless `gemini -p … -o stream-json`. */
export async function detectGemini(): Promise<GeminiInfo> {
  const path = which('gemini');
  if (!path) return { installed: false, ready: false, detail: t('Gemini CLI introuvable dans le PATH') };
  const ver = await exec(path, ['--version'], { timeoutMs: 5000 });
  const version = firstLine(ver.stdout) || firstLine(ver.stderr) || undefined;
  return { installed: true, path, version, ready: true, detail: `Gemini CLI${version ? ` ${version}` : ''}` };
}

/** aider : `aider --message … --yes` (nécessite un provider configuré dans l’environnement). */
export async function detectAider(): Promise<AiderInfo> {
  const path = which('aider');
  if (!path) return { installed: false, ready: false, detail: t('aider introuvable dans le PATH') };
  const ver = await exec(path, ['--version'], { timeoutMs: 8000 });
  const version = firstLine(ver.stdout) || undefined;
  const ok = ver.code === 0;
  return {
    installed: true,
    path,
    version: ok ? version : undefined,
    ready: true,
    detail: ok ? `aider ${version ?? ''}`.trim() : t('aider installé (interpréteur à vérifier : {v})', { v: firstLine(ver.stderr) || t('échec --version') }),
  };
}

/** LM Studio fonctionne via son serveur OpenAI-compatible (`lms server`). */
export async function detectLms(cfg: Config): Promise<LmsInfo> {
  const baseUrl = cfg.lms.base_url;
  const path = which('lms');
  if (!path) return { installed: false, ready: false, running: false, baseUrl, models: [], detail: t('CLI `lms` introuvable') };
  const ver = await exec(path, ['--version'], { timeoutMs: 5000 });
  const version = /commit:\s*(\S+)/i.exec(ver.stdout + ver.stderr)?.[1] ?? firstLine(ver.stdout) ?? undefined;
  let running = (await openAiModels(baseUrl, 1200)) !== null;
  if (!running && cfg.lms.autostart) running = await ensureLmsRunning(cfg, path, baseUrl);
  const served = running ? await openAiModels(baseUrl) : null;
  const models = (served ?? []).map((m) => ({ id: m.id, label: m.id, loaded: true, fits: true }));
  return {
    installed: true,
    path,
    version,
    running,
    ready: running,
    baseUrl,
    models,
    detail: running
      ? t('serveur LM Studio ({v})', { v: models.length ? t('{length} modèle(s)', { length: models.length }) : t('aucun modèle — télécharge-en dans LM Studio') })
      : t('installé mais serveur arrêté (démarrage auto impossible)'),
  };
}

/** llama.cpp : serveur OpenAI-compatible (`llama-server`) et CLI (`llama-cli`) pour les modèles GGUF. */
export async function detectLlamacpp(cfg: Config, hw: HardwareInfo): Promise<LlamacppInfo> {
  const cliPath = which('llama-cli') ?? undefined;
  const serverPath = which('llama-server') ?? undefined;
  const baseUrl = cfg.llamacpp.base_url;
  if (!cliPath && !serverPath) {
    return { installed: false, ready: false, runningServer: false, baseUrl, models: [], detail: t('llama.cpp introuvable') };
  }
  const ver = await exec((cliPath ?? serverPath)!, ['--version'], { timeoutMs: 5000 });
  const version = /version:\s*([^\s(]+)/.exec(ver.stdout + ver.stderr)?.[1];
  const runningServer = (await openAiModels(baseUrl, 1000)) !== null;
  const served = runningServer ? await openAiModels(baseUrl) : null;

  const models: LocalModel[] = [];
  const seen = new Set<string>();
  for (const m of served ?? []) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({ id: m.id, label: m.id, path: m.id, loaded: true, fits: true });
  }
  for (const dir of expandDirs(cfg.llamacpp.models_dirs)) {
    for (const file of findGguf(dir)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      models.push({ id: file.name, path: file.path, sizeGB: file.sizeGB, fits: file.sizeGB <= hw.localBudgetGB });
    }
  }
  return {
    installed: true,
    path: cliPath ?? serverPath,
    cliPath,
    serverPath,
    version,
    runningServer,
    baseUrl,
    models,
    ready: runningServer || (models.length > 0 && Boolean(cliPath)),
    detail: !models.length
      ? t('installé, aucun modèle GGUF trouvé (voir llamacpp.models_dirs)')
      : t('{length} modèle(s) GGUF · {v}', { length: models.length, v: runningServer ? t('serveur en marche') : cliPath ? t('via llama-cli') : 'llama-server' }),
  };
}

interface ServedModel {
  id: string;
}

async function openAiModels(baseUrl: string, timeoutMs = 1500): Promise<ServedModel[] | null> {
  const r = await getJson<{ data?: { id?: string }[]; models?: { name?: string; id?: string }[] }>(
    `${baseUrl}/v1/models`,
    timeoutMs,
  );
  if (!r) return null;
  const list = [...(r.data ?? []), ...(r.models ?? [])] as { id?: string; name?: string }[];
  return list.map((m) => ({ id: m.id ?? m.name ?? '' })).filter((m) => m.id);
}

/** `lms server start` en arrière-plan, puis attente du serveur. */
export async function ensureLmsRunning(_cfg: Config, bin: string, baseUrl: string): Promise<boolean> {
  try {
    spawn(bin, ['server', 'start'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (await openAiModels(baseUrl, 800)) return true;
  }
  return false;
}

const expandDirs = (dirs: string[]): string[] =>
  dirs.map((d) => (d.startsWith('~') ? join(homedir(), d.slice(1)) : d));

/** Liste (récursive) des fichiers `.gguf` d’un dossier, bornée pour ne pas scanner tout le disque. */
function findGguf(dir: string, limit = 40): { name: string; path: string; sizeGB: number }[] {
  if (!existsSync(dir)) return [];
  const out: { name: string; path: string; sizeGB: number }[] = [];
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (out.length >= limit) break;
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue;
      const full = join(entry.parentPath ?? dir, entry.name);
      let sizeGB = 0;
      try {
        sizeGB = round1(statSync(full).size / 1024 ** 3);
      } catch {
        /* taille inconnue */
      }
      out.push({ name: entry.name, path: full, sizeGB });
    }
  } catch {
    /* dossier illisible */
  }
  return out;
}

const KNOWN_CLIS = [
  'codex',
  'goose',
  'amp',
  'cursor-agent',
  'copilot',
  'qwen',
  'kimi',
  'cline',
  'droid',
  'llm',
  'mods',
  'mlx_lm.generate',
  'mlx_lm.server',
  'sgpt',
  'crush',
  'pi',
];

export function detectOtherClis(): OtherCli[] {
  const out: OtherCli[] = [];
  for (const name of KNOWN_CLIS) {
    const path = which(name);
    if (path) out.push({ name, path });
  }
  return out;
}

export async function detectHuggingface(): Promise<HuggingfaceInfo> {
  const path = which('hf') ?? which('huggingface-cli');
  if (!path) return { installed: false, ready: false, detail: t('hf introuvable (pip install -U "huggingface_hub[cli]")') };
  return { installed: true, ready: true, path, detail: t('téléchargement de modèles Hugging Face') };
}

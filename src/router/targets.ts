import type { Config } from '../config/schema.js';
import { ConfigSchema } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { BackendId, Level, Target } from '../types.js';
import { t } from '../i18n/index.js';

const prefIndex = (model: string, preferred: string[]): number => {
  const i = preferred.findIndex((p) => model === p || model.endsWith(`/${p}`));
  return i === -1 ? preferred.length : i;
};

/** IA dont le modèle/mode par défaut se choisit dans la config (voir `/model`). */
export const CONFIGURABLE_BACKENDS: BackendId[] = ['opencode', 'ollama', 'gemini', 'vibe', 'aider', 'lms', 'llamacpp'];

/** Tous les outils IA pilotables, dans l'ordre d'affichage de `/tools`. */
export const ALL_BACKENDS: { id: BackendId; label: string; configKey: string }[] = [
  { id: 'claude', label: 'Claude Code', configKey: 'claude.enabled' },
  { id: 'opencode', label: 'OpenCode', configKey: 'opencode.enabled' },
  { id: 'ollama', label: 'Ollama', configKey: 'ollama.enabled' },
  { id: 'copilot', label: 'Copilot (VS Code)', configKey: 'copilot.enabled' },
  { id: 'gemini', label: 'Gemini CLI', configKey: 'gemini.enabled' },
  { id: 'vibe', label: 'Mistral Vibe', configKey: 'vibe.enabled' },
  { id: 'aider', label: 'aider', configKey: 'aider.enabled' },
  { id: 'lms', label: 'LM Studio', configKey: 'lms.enabled' },
  { id: 'llamacpp', label: 'llama.cpp', configKey: 'llamacpp.enabled' },
];

/** true si l'outil est coché dans `/tools` (jamais appelé sinon). */
export function isBackendEnabled(cfg: Config, backend: BackendId): boolean {
  return cfg[backend].enabled;
}

/** Résume l'état on/off de chaque outil (pour `/tools` et `codebreak tools`). */
export function backendToggleState(cfg: Config): Record<BackendId, boolean> {
  return {
    claude: cfg.claude.enabled,
    opencode: cfg.opencode.enabled,
    ollama: cfg.ollama.enabled,
    copilot: cfg.copilot.enabled,
    gemini: cfg.gemini.enabled,
    vibe: cfg.vibe.enabled,
    aider: cfg.aider.enabled,
    lms: cfg.lms.enabled,
    llamacpp: cfg.llamacpp.enabled,
  };
}

/** Clé de config et valeur actuelle du modèle/mode par défaut d'un backend, pour `/models` et le panneau d'usage. */
export function defaultModelInfo(backend: BackendId, cfg: Config): { key: string; value: string; auto: boolean } {
  switch (backend) {
    case 'opencode':
      return { key: 'opencode.preferred', value: cfg.opencode.preferred[0] ?? 'auto', auto: cfg.opencode.preferred.length === 0 };
    case 'ollama':
      return { key: 'ollama.preferred_model', value: cfg.ollama.preferred_model || 'auto', auto: !cfg.ollama.preferred_model };
    case 'gemini':
      return { key: 'gemini.model', value: cfg.gemini.model, auto: cfg.gemini.model === 'auto' };
    case 'vibe':
      return { key: 'vibe.agent', value: cfg.vibe.agent, auto: false };
    case 'aider':
      return { key: 'aider.model', value: cfg.aider.model || 'auto', auto: !cfg.aider.model };
    case 'lms':
      return { key: 'lms.preferred_model', value: cfg.lms.preferred_model || 'auto', auto: !cfg.lms.preferred_model };
    case 'llamacpp':
      return { key: 'llamacpp.preferred_model', value: cfg.llamacpp.preferred_model || 'auto', auto: !cfg.llamacpp.preferred_model };
    case 'claude':
      return { key: '', value: t('auto (opus/sonnet/haiku selon la tâche et le quota)'), auto: true };
    case 'copilot':
      return { key: 'copilot.mode', value: cfg.copilot.mode, auto: false };
  }
}

/** Modèles proposés pour `/model <backend>` (déduits de la détection + choix déjà enregistrés). */
export function availableModels(backend: BackendId, det: Detection, cfg?: Config): string[] {
  switch (backend) {
    case 'opencode':
      // gratuits détectés + modèles déjà choisis (extra payants, preferred) : tout choix direct reste proposable
      return cfg ? opencodeModels(det, cfg) : [...det.opencode.freeModels];
    case 'ollama':
      return det.ollama.models.filter((m) => m.capabilities.includes('completion') && m.fits).map((m) => m.name);
    case 'lms':
      return det.lms.models.filter((m) => m.fits).map((m) => m.id);
    case 'llamacpp':
      return det.llamacpp.models.filter((m) => m.fits).map((m) => m.id);
    case 'vibe':
      return ['ask', 'plan', 'accept-edits', 'auto-approve', 'smart-approve'];
    default:
      return [];
  }
}

/** Écritures config pour fixer le modèle/mode par défaut d'un backend (`/models`, CLI `model`).
 *  `value === ''` (choix « auto ») restaure les défauts du schéma. */
export function modelDefaultWrites(backend: BackendId, value: string, cfg: Config): [string, unknown][] {
  if (backend === 'opencode') {
    return [
      [
        'opencode.preferred',
        value ? [value, ...cfg.opencode.preferred.filter((m) => m !== value)] : ConfigSchema.parse({}).opencode.preferred,
      ],
    ];
  }
  return [[defaultModelInfo(backend, cfg).key, value]];
}

/** IDs OpenCode routables : gratuits détectés + extra configurés + choix `preferred`
 * réellement nouveaux (un provider payant fixé via `/model opencode <id>`). Les vieux
 * raccourcis déjà couverts par un id complet (`big-pickle` → `opencode/big-pickle`)
 * et les défauts périmés sont ignorés pour ne pas créer de cible qui échouerait. */
const DEFAULT_PREFERRED: readonly string[] = ConfigSchema.parse({}).opencode.preferred;

export function opencodeModels(det: Detection, cfg: Config): string[] {
  const known = [...new Set([...det.opencode.freeModels, ...cfg.opencode.extra_models])];
  const covered = (p: string) => known.some((k) => k === p || k.endsWith(`/${p}`) || p.endsWith(`/${k}`));
  const extra = cfg.opencode.preferred.filter((p) => !covered(p) && !DEFAULT_PREFERRED.includes(p));
  return [...known, ...extra];
}

export function buildTargets(det: Detection, cfg: Config): Target[] {
  const out: Target[] = [];

  if (det.claude.installed && det.claude.ready && cfg.claude.enabled) {
    const caps = { tools: true, mcp: true, vision: true, capture: true, contextK: 200 };
    const claude = (model: string, label: string, level: Level, power: number): Target => ({
      id: `claude:${model}`,
      backend: 'claude',
      model,
      label,
      level,
      cost: 'subscription',
      power,
      cloud: true,
      caps,
    });
    out.push(claude('opus', 'Claude Opus', 4, 3), claude('sonnet', 'Claude Sonnet', 3, 2), claude('haiku', 'Claude Haiku', 2, 1));
  }

  if (det.opencode.installed && cfg.opencode.enabled) {
    // + choix preferred réellement nouveaux : un modèle fixé directement via
    // `/model opencode <id>` devient routable même hors gratuits détectés (ex. provider
    // payant) ; s'il n'existe pas côté OpenCode, l'exécution échoue et l'escalade relaie.
    const models = opencodeModels(det, cfg);
    for (const m of models) {
      const rank = prefIndex(m, cfg.opencode.preferred);
      out.push({
        id: `opencode:${m}`,
        backend: 'opencode',
        model: m,
        label: `OpenCode ${m.replace(/^opencode\//, '')}`,
        level: 1,
        cost: 'free',
        power: 100 - rank,
        cloud: true,
        caps: { tools: true, mcp: false, vision: false, capture: true, contextK: 64 },
      });
    }
  }

  if (det.ollama.installed && cfg.ollama.enabled) {
    for (const m of det.ollama.models) {
      if (!m.capabilities.includes('completion') || !m.fits) continue;
      const agent = m.capabilities.includes('tools') && det.opencode.installed;
      const ctx = agent ? cfg.ollama.agent_num_ctx : cfg.ollama.chat_num_ctx;
      const preferred = cfg.ollama.preferred_model && m.name === cfg.ollama.preferred_model;
      out.push({
        id: `ollama:${m.name}`,
        backend: 'ollama',
        model: m.name,
        label: `Ollama ${m.name}`,
        level: 0,
        cost: 'free',
        power: (m.paramsB ?? m.sizeGB) + (preferred ? 1000 : 0),
        cloud: false,
        caps: {
          tools: agent,
          mcp: false,
          vision: m.capabilities.includes('vision'),
          capture: true,
          contextK: Math.min(ctx, m.contextLength ?? ctx) / 1024,
        },
      });
    }
  }

  if (det.copilot.ready && cfg.copilot.enabled) {
    out.push({
      id: 'copilot:agent',
      backend: 'copilot',
      model: cfg.copilot.mode,
      label: 'Copilot (VS Code)',
      level: 2,
      cost: 'included',
      power: 1,
      cloud: true,
      terminal: true,
      caps: { tools: true, mcp: cfg.copilot.mcp, vision: true, capture: false, contextK: 128 },
    });
  }

  if (det.gemini.installed && cfg.gemini.enabled) {
    out.push({
      id: 'gemini:auto',
      backend: 'gemini',
      model: cfg.gemini.model,
      label: cfg.gemini.model === 'auto' ? 'Gemini CLI' : `Gemini ${cfg.gemini.model}`,
      level: 1,
      cost: 'free',
      power: 3,
      cloud: true,
      caps: { tools: true, mcp: false, vision: false, capture: true, contextK: 1000 },
    });
  }

  if (det.vibe.installed && cfg.vibe.enabled) {
    out.push({
      id: 'vibe:agent',
      backend: 'vibe',
      model: cfg.vibe.agent,
      label: 'Mistral Vibe',
      level: 2,
      cost: 'subscription',
      power: 1,
      cloud: true,
      caps: { tools: true, mcp: false, vision: false, capture: true, contextK: 128 },
    });
  }

  if (det.aider.installed && cfg.aider.enabled) {
    out.push({
      id: 'aider:default',
      backend: 'aider',
      model: cfg.aider.model || 'default',
      label: cfg.aider.model ? `aider ${cfg.aider.model}` : 'aider',
      level: 2,
      cost: 'subscription',
      power: 1,
      cloud: true,
      caps: { tools: true, mcp: false, vision: false, capture: true, contextK: 128 },
    });
  }

  if (det.lms.installed && cfg.lms.enabled) {
    for (const m of det.lms.models) {
      if (!m.fits) continue;
      const preferred = cfg.lms.preferred_model && (m.id === cfg.lms.preferred_model || m.label === cfg.lms.preferred_model);
      out.push({
        id: `lms:${m.id}`,
        backend: 'lms',
        model: m.id,
        label: `LM Studio ${m.label ?? m.id}`,
        level: 0,
        cost: 'free',
        power: (m.sizeGB ?? 1) + (preferred ? 1000 : 0),
        cloud: false,
        caps: { tools: false, mcp: false, vision: false, capture: true, contextK: 32 },
      });
    }
  }

  if (det.llamacpp.installed && cfg.llamacpp.enabled) {
    for (const m of det.llamacpp.models) {
      if (!m.fits) continue;
      const preferred =
        cfg.llamacpp.preferred_model && (m.id === cfg.llamacpp.preferred_model || m.label === cfg.llamacpp.preferred_model);
      out.push({
        id: `llamacpp:${m.id}`,
        backend: 'llamacpp',
        model: m.id,
        label: `llama.cpp ${m.label ?? m.id}`,
        level: 0,
        cost: 'free',
        power: (m.sizeGB ?? 1) + (preferred ? 1000 : 0),
        cloud: false,
        caps: { tools: false, mcp: false, vision: false, capture: true, contextK: cfg.llamacpp.num_ctx / 1024 },
      });
    }
  }

  return out
    .map((t) => {
      const o = cfg.targets[t.id];
      return o?.level !== undefined ? { ...t, level: o.level as Level } : t;
    })
    .filter((t) => cfg.targets[t.id]?.enabled !== false);
}

const ALIASES: Record<string, (t: Target) => boolean> = {
  opus: (t) => t.id === 'claude:opus',
  sonnet: (t) => t.id === 'claude:sonnet',
  haiku: (t) => t.id === 'claude:haiku',
  claude: (t) => t.id === 'claude:sonnet',
  local: (t) => !t.cloud,
  ollama: (t) => t.backend === 'ollama',
  free: (t) => t.backend === 'opencode',
  opencode: (t) => t.backend === 'opencode',
  copilot: (t) => t.backend === 'copilot',
  vscode: (t) => t.backend === 'copilot',
  vibe: (t) => t.backend === 'vibe',
  gemini: (t) => t.backend === 'gemini',
  aider: (t) => t.backend === 'aider',
  lms: (t) => t.backend === 'lms',
  lmstudio: (t) => t.backend === 'lms',
  llama: (t) => t.backend === 'llamacpp',
  llamacpp: (t) => t.backend === 'llamacpp',
};

/** Résout un alias (@opus, @local…) ou un id complet en cible ; la plus puissante gagne. */
export function resolveTarget(name: string, targets: Target[]): Target | undefined {
  const exact = targets.find((t) => t.id === name || t.model === name);
  if (exact) return exact;
  const match = ALIASES[name.toLowerCase()];
  if (!match) return undefined;
  return targets.filter(match).sort((a, b) => b.power - a.power)[0];
}

export const FORCE_ALIASES = Object.keys(ALIASES);

/** Extrait un forçage en tête de prompt : "@opus fais X". */
export function parseForce(
  prompt: string,
  targets: Target[],
): { prompt: string; target?: Target; unknown?: string } {
  const m = /^\s*@([\w:./-]+)\s+([\s\S]+)$/.exec(prompt);
  if (!m) return { prompt };
  const target = resolveTarget(m[1]!, targets);
  if (!target) return { prompt, unknown: m[1]! };
  return { prompt: m[2]!.trim(), target };
}

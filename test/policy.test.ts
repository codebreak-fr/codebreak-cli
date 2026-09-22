import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { analyzeByRules } from '../src/router/heuristics.js';
import { decide } from '../src/router/policy.js';
import { buildTargets, parseForce } from '../src/router/targets.js';
import type { Detection } from '../src/detect/types.js';
import type { QuotaState, TaskFeatures } from '../src/types.js';

const det: Detection = {
  hardware: {
    platform: 'darwin', arch: 'arm64', chip: 'Apple M4', cores: { total: 10 }, memoryGB: 16, freeMemoryGB: 6,
    appleSilicon: true, mlx: { supported: true, pythonMlx: true, pythonMlxLm: true }, gpus: [], backend: 'metal', vramGB: 0, onBattery: false,
    lowPowerMode: false, localBudgetGB: 8, tier: 'medium', recommendation: '',
  },
  claude: { installed: true, ready: true, detail: '' },
  opencode: {
    installed: true,
    ready: true,
    detail: '',
    freeModels: ['opencode/nemotron-3-ultra-free', 'opencode/big-pickle', 'opencode/mimo-v2.5-free'],
    allModels: [],
  },
  ollama: {
    installed: true, ready: true, running: true, baseUrl: '', detail: '',
    models: [
      { name: 'ministral-3:3b', sizeGB: 2.8, paramsB: 3.8, capabilities: ['completion', 'tools'], fits: true, loaded: true },
      { name: 'ministral-3:8b', sizeGB: 5.6, paramsB: 8.9, capabilities: ['completion', 'tools'], fits: true, loaded: false },
    ],
  },
  copilot: { installed: true, ready: true, chatSupported: true, extensionInstalled: false, detail: '' },
  vibe: { installed: true, ready: true, detail: '', version: '2.25.1' },
  gemini: { installed: true, ready: true, detail: '', version: '0.59.0' },
  aider: { installed: true, ready: true, detail: '', version: '0.86.2' },
  lms: { installed: true, ready: false, running: false, baseUrl: 'http://localhost:1234', detail: '', models: [] },
  llamacpp: { installed: true, ready: false, runningServer: false, baseUrl: 'http://localhost:8080', detail: '', models: [] },
  huggingface: { installed: false, ready: false, detail: '' },
  inventory: { apps: [], models: [], packages: [] },
  others: [], at: 0,
};

const cfg = ConfigSchema.parse({});
const targets = buildTargets(det, cfg);
const feat = (over: Partial<TaskFeatures> = {}): TaskFeatures => ({
  ...analyzeByRules('renomme foo en bar'),
  confidence: 0.9,
  ...over,
});
const run = (f: TaskFeatures, quota: QuotaState = 'ok', c = cfg, extra = {}) =>
  decide({ features: f, targets: buildTargets(det, c), cfg: c, quota, ...extra });

describe('construction des cibles', () => {
  it('crée Claude ×3, OpenCode gratuit, Ollama, Copilot', () => {
    expect(targets.map((t) => t.id)).toEqual(
      expect.arrayContaining(['claude:opus', 'claude:sonnet', 'claude:haiku', 'opencode:opencode/big-pickle', 'ollama:ministral-3:8b', 'copilot:agent']),
    );
  });
  it('route aussi Gemini, Vibe et aider', () => {
    expect(targets.map((t) => t.id)).toEqual(expect.arrayContaining(['gemini:auto', 'vibe:agent', 'aider:default']));
    expect(targets.find((t) => t.id === 'gemini:auto')).toMatchObject({ backend: 'gemini', level: 1, cloud: true, caps: { tools: true, capture: true } });
  });
  it('OpenCode : Nemotron Ultra est préféré', () => {
    const oc = targets.filter((t) => t.backend === 'opencode').sort((a, b) => b.power - a.power);
    expect(oc[0]!.model).toBe('opencode/nemotron-3-ultra-free');
  });
  it('LM Studio et llama.cpp : une cible locale par modèle découvert', () => {
    const d: Detection = {
      ...det,
      lms: { installed: true, ready: true, running: true, baseUrl: 'http://localhost:1234', detail: '', models: [{ id: 'qwen2.5-7b', sizeGB: 4.5, fits: true }] },
      llamacpp: { installed: true, ready: true, runningServer: false, baseUrl: 'http://localhost:8080', detail: '', models: [{ id: 'llama-3.2-3b.gguf', path: '/models/llama-3.2-3b.gguf', sizeGB: 2, fits: true }] },
    };
    const ids = buildTargets(d, cfg).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['lms:qwen2.5-7b', 'llamacpp:llama-3.2-3b.gguf']));
    const lmsTarget = buildTargets(d, cfg).find((t) => t.id === 'lms:qwen2.5-7b')!;
    expect(lmsTarget).toMatchObject({ backend: 'lms', level: 0, cloud: false, caps: { tools: false } });
  });
  it('les alias forcent les nouveaux backends', () => {
    expect(parseForce('@gemini réponds', targets).target?.id).toBe('gemini:auto');
    expect(parseForce('@vibe fais-le', targets).target?.id).toBe('vibe:agent');
    expect(parseForce('@aider corrige', targets).target?.id).toBe('aider:default');
  });
});

describe('politique de routage', () => {
  it('tâche triviale → Ollama local (le plus gros qui tient), escalade prévue', () => {
    const d = run(feat({ complexity: 1, category: 'chore', security: false }));
    expect(d.primary?.id).toBe('ollama:ministral-3:8b');
    expect(d.chain.map((t) => t.backend)).toEqual(['ollama', 'opencode', 'claude']);
    expect(d.chain[2]!.id).toBe('claude:sonnet');
  });

  it('complexité 2 → OpenCode gratuit', () => {
    expect(run(feat({ complexity: 2 })).primary?.backend).toBe('opencode');
  });

  it('complexité 3-4 → Sonnet (jamais Opus)', () => {
    expect(run(feat({ complexity: 3 })).primary?.id).toBe('claude:sonnet');
    expect(run(feat({ complexity: 4 })).primary?.id).toBe('claude:sonnet');
  });

  it('Opus seulement pour la complexité 5', () => {
    expect(run(feat({ complexity: 5 })).primary?.id).toBe('claude:opus');
  });

  it('sécurité : jamais de niveau 0/1, même si tâche facile', () => {
    const d = run(feat({ complexity: 1, security: true, category: 'auth_security' }));
    expect(d.primary?.level).toBeGreaterThanOrEqual(3);
    expect(d.primary?.backend).toBe('claude');
  });

  it('sécurité difficile → Opus préféré', () => {
    expect(run(feat({ complexity: 4, security: true, category: 'auth_security' })).primary?.id).toBe('claude:opus');
  });

  it('MCP (Figma) → cible avec MCP', () => {
    const d = run(feat({ complexity: 2, needsMcp: true, vision: true }));
    expect(d.primary?.caps.mcp).toBe(true);
  });

  it('question pure sans dépôt → peut rester local', () => {
    const d = run(feat({ complexity: 1, needsEdit: false, needsRepo: false, category: 'question' }));
    expect(d.primary?.backend).toBe('ollama');
  });

  it('quota tendu : Opus réservé au critique, complexité 3 déclassée', () => {
    expect(run(feat({ complexity: 4, security: true, category: 'auth_security' }), 'soft').primary?.id).toBe('claude:opus');
    expect(run(feat({ complexity: 5, security: false }), 'soft').primary?.id).toBe('claude:opus');
    expect(run(feat({ complexity: 3 }), 'soft').primary?.level).toBe(2);
  });

  it('quota critique : Opus interdit, complexité 3 → gratuit, sécurité → Sonnet', () => {
    const hard = run(feat({ complexity: 5 }), 'hard');
    expect(hard.primary?.id).toBe('claude:sonnet');
    expect(run(feat({ complexity: 3 }), 'hard').primary?.backend).toBe('opencode');
    const sec = run(feat({ complexity: 4, security: true, category: 'auth_security' }), 'hard');
    expect(sec.primary?.id).toBe('claude:sonnet');
    expect(sec.chain.find((t) => t.id === 'claude:opus')).toBeUndefined();
  });

  it('quota épuisé : plus aucune cible Claude, repli signalé', () => {
    const d = run(feat({ complexity: 4, security: true, category: 'auth_security' }), 'stop');
    expect(d.chain.some((t) => t.backend === 'claude')).toBe(false);
    expect(d.degraded).toBe(true);
    expect(d.warnings.join(' ')).toMatch(/épuisé/);
  });

  it('secret détecté → local uniquement', () => {
    const d = run(feat({ complexity: 4 }), 'ok', cfg, { privacyLocked: true });
    expect(d.primary?.cloud).toBe(false);
    expect(d.chain.every((t) => !t.cloud)).toBe(true);
  });

  it('secret + action block → aucune cible', () => {
    const c = ConfigSchema.parse({ privacy: { action: 'block' } });
    expect(run(feat(), 'ok', c, { privacyLocked: true }).primary).toBeNull();
  });

  it('profil eco : complexité 3 → gratuit ; profil quality : 2 → Sonnet', () => {
    const eco = ConfigSchema.parse({ profile: 'eco' });
    expect(run(feat({ complexity: 3 }), 'ok', eco).primary?.backend).toBe('opencode');
    const q = ConfigSchema.parse({ profile: 'quality' });
    expect(run(feat({ complexity: 2 }), 'ok', q).primary?.id).toBe('claude:sonnet');
  });

  it('Copilot : sélectionné sous quota tendu, chaîne terminale', () => {
    const d = run(feat({ complexity: 3 }), 'soft');
    expect(d.primary?.backend).toBe('copilot');
    expect(d.chain).toHaveLength(1);
  });

  it('Copilot désactivé en auto → jamais choisi', () => {
    const c = ConfigSchema.parse({ copilot: { auto_route: false } });
    expect(run(feat({ complexity: 3 }), 'soft', c).primary?.backend).toBe('claude');
  });

  it('escalade limitée par max_attempts', () => {
    const c = ConfigSchema.parse({ escalation: { max_attempts: 2 } });
    expect(run(feat({ complexity: 1, security: false }), 'ok', c).chain).toHaveLength(2);
    const off = ConfigSchema.parse({ escalation: { enabled: false } });
    expect(run(feat({ complexity: 1 }), 'ok', off).chain).toHaveLength(1);
  });

  it('cible pénalisée par l’historique est écartée', () => {
    const d = run(feat({ complexity: 1 }), 'ok', cfg, { penalized: (t: { backend: string }) => t.backend === 'ollama' });
    expect(d.primary?.backend).toBe('opencode');
  });

  it('forçage @opus', () => {
    const p = parseForce('@opus revois cette architecture', targets);
    expect(p.target?.id).toBe('claude:opus');
    expect(p.prompt).toBe('revois cette architecture');
    const d = run(feat(), 'ok', cfg, { forced: p.target });
    expect(d.forced).toBe(true);
    expect(d.chain).toHaveLength(1);
    expect(parseForce('@inconnu bla', targets).unknown).toBe('inconnu');
  });
});

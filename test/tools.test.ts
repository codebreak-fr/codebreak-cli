import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { analyzeByRules } from '../src/router/heuristics.js';
import { decide } from '../src/router/policy.js';
import { ALL_BACKENDS, availableModels, backendToggleState, buildTargets, isBackendEnabled, opencodeModels, parseForce } from '../src/router/targets.js';
import { pickRouterModel } from '../src/router/classifier.js';
import { route } from '../src/router/index.js';
import { detection, defaultCfg } from './helpers.js';

describe('toggle des outils IA (/tools)', () => {
  it('liste les 9 outils pilotables', () => {
    expect(ALL_BACKENDS.map((b) => b.id).sort()).toEqual(
      ['aider', 'claude', 'copilot', 'gemini', 'llamacpp', 'lms', 'ollama', 'opencode', 'vibe'].sort(),
    );
  });

  it('tous activés par défaut', () => {
    const state = backendToggleState(defaultCfg());
    expect(Object.values(state).every(Boolean)).toBe(true);
    expect(isBackendEnabled(defaultCfg(), 'ollama')).toBe(true);
  });

  it('un outil décoché ne produit aucune cible', () => {
    const cfg = ConfigSchema.parse({ ollama: { enabled: false }, opencode: { enabled: false } });
    const ids = buildTargets(detection, cfg).map((t) => t.id);
    expect(ids.some((id) => id.startsWith('ollama:'))).toBe(false);
    expect(ids.some((id) => id.startsWith('opencode:'))).toBe(false);
    // les autres restent
    expect(ids).toContain('claude:sonnet');
  });

  it('le routeur automatique ne choisit jamais un outil décoché', () => {
    const feat = { ...analyzeByRules('renomme foo en bar'), confidence: 0.9 };
    const cfg = ConfigSchema.parse({ ollama: { enabled: false }, opencode: { enabled: false }, copilot: { auto_route: false } });
    const d = decide({ features: feat, targets: buildTargets(detection, cfg), cfg, quota: 'ok' });
    expect(d.primary?.backend).not.toBe('ollama');
    expect(d.primary?.backend).not.toBe('opencode');
    expect(d.chain.every((t) => t.backend !== 'ollama' && t.backend !== 'opencode')).toBe(true);
  });

  it('le LLM routeur ne tourne jamais sur un backend désactivé', () => {
    expect(pickRouterModel(detection, defaultCfg())?.provider).toBe('ollama');
    const noOllama = ConfigSchema.parse({ ollama: { enabled: false } });
    expect(pickRouterModel(detection, noOllama)?.provider).toBe('opencode');
    const noLocal = ConfigSchema.parse({ ollama: { enabled: false }, opencode: { enabled: false } });
    expect(pickRouterModel(detection, noLocal)?.provider).toBe('claude');
    const noRouter = ConfigSchema.parse({ ollama: { enabled: false }, opencode: { enabled: false }, claude: { enabled: false } });
    expect(pickRouterModel(detection, noRouter)).toBeNull();
  });

  it('@alias vers un outil désactivé = inconnu + avertissement explicite', async () => {
    const cfg = ConfigSchema.parse({ gemini: { enabled: false } });
    const targets = buildTargets(detection, cfg);
    expect(targets.find((t) => t.backend === 'gemini')).toBeUndefined();
    expect(parseForce('@gemini réponds', targets).target).toBeUndefined();
    const { decision } = await route('@gemini réponds vite', { cwd: '/tmp', cfg, det: detection, usage: null });
    expect(decision.warnings.join(' ')).toMatch(/désactivé|indisponible/);
    expect(decision.primary?.backend).not.toBe('gemini');
  });
});

describe('choix du modèle OpenCode (/model, @modèle)', () => {
  it('par défaut : seuls les gratuits détectés sont routables (pas de doublon périmé)', () => {
    expect(opencodeModels(detection, defaultCfg())).toEqual(['opencode/big-pickle']);
    expect(buildTargets(detection, defaultCfg()).map((t) => t.id)).toContain('opencode:opencode/big-pickle');
  });

  it('un modèle fixé directement devient routable même hors gratuits (ex. provider payant)', () => {
    const cfg = ConfigSchema.parse({ opencode: { preferred: ['anthropic/claude-sonnet-4-5'] } });
    expect(opencodeModels(detection, cfg)).toContain('anthropic/claude-sonnet-4-5');
    expect(buildTargets(detection, cfg).map((t) => t.id)).toContain('opencode:anthropic/claude-sonnet-4-5');
    expect(availableModels('opencode', detection, cfg)).toContain('anthropic/claude-sonnet-4-5');
  });

  it('forçage par prompt avec l’id exact du modèle (@opencode/…)', () => {
    const targets = buildTargets(detection, defaultCfg());
    expect(parseForce('@opencode/big-pickle fais X', targets).target?.id).toBe('opencode:opencode/big-pickle');
  });
});

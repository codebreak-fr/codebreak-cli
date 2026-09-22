import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { modelDefaultWrites } from '../src/router/targets.js';
import { defaultCfg } from './helpers.js';

describe('modelDefaultWrites (/models, CLI model)', () => {
  it('opencode : le modèle choisi passe en premier, sans doublon', () => {
    const cfg = ConfigSchema.parse({ opencode: { preferred: ['a', 'opencode/muse-spark-1.3-contributor-free', 'b'] } });
    expect(modelDefaultWrites('opencode', 'opencode/muse-spark-1.3-contributor-free', cfg)).toEqual([
      ['opencode.preferred', ['opencode/muse-spark-1.3-contributor-free', 'a', 'b']],
    ]);
  });

  it('opencode : un nouveau modèle est ajouté en tête', () => {
    const writes = modelDefaultWrites('opencode', 'anthropic/claude-sonnet-4-5', defaultCfg());
    const preferred = writes[0]![1] as string[];
    expect(writes[0]![0]).toBe('opencode.preferred');
    expect(preferred[0]).toBe('anthropic/claude-sonnet-4-5');
  });

  it('opencode : valeur vide (auto) restaure les défauts du schéma', () => {
    const cfg = ConfigSchema.parse({ opencode: { preferred: ['x'] } });
    expect(modelDefaultWrites('opencode', '', cfg)).toEqual([
      ['opencode.preferred', ConfigSchema.parse({}).opencode.preferred],
    ]);
  });

  it('autres backends : clé pointée directe', () => {
    expect(modelDefaultWrites('ollama', 'qwen3:8b', defaultCfg())).toEqual([['ollama.preferred_model', 'qwen3:8b']]);
    expect(modelDefaultWrites('gemini', 'gemini-2.5-flash', defaultCfg())).toEqual([['gemini.model', 'gemini-2.5-flash']]);
    expect(modelDefaultWrites('vibe', 'plan', defaultCfg())).toEqual([['vibe.agent', 'plan']]);
  });
});

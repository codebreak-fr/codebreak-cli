import { describe, expect, it } from 'vitest';
import { describeToolsChange, normalizeBackend, parseModelArgs, parseToolsArgs, toolsWrites } from '../src/commands/args.js';
import { COMMANDS } from '../src/ui/commands.js';

describe('commandes partagées CLI/TUI', () => {
  it('alias d’outils', () => {
    expect(normalizeBackend('llama')).toBe('llamacpp');
    expect(normalizeBackend('LMStudio')).toBe('lms');
    expect(normalizeBackend('free')).toBe('opencode');
    expect(normalizeBackend('nope')).toBeUndefined();
  });
  it('tools on|off <outil…> et reset', () => {
    const off = parseToolsArgs(['off', 'ollama', 'gemini']);
    expect(off).toEqual({ ok: true, value: { mode: 'off', ids: ['ollama', 'gemini'] } });
    expect(toolsWrites({ mode: 'off', ids: ['ollama', 'gemini'] })).toEqual([['ollama.enabled', false], ['gemini.enabled', false]]);
    expect(parseToolsArgs(['reset'])).toMatchObject({ ok: true, value: { mode: 'reset' } });
    expect(describeToolsChange({ mode: 'on', ids: ['claude'] })).toBe('Outils → claude on');
  });
  it('tools : syntaxes redondantes retirées, erreurs explicites', () => {
    expect(parseToolsArgs(['ollama'])).toMatchObject({ ok: false });
    expect(parseToolsArgs(['ollama', 'off'])).toMatchObject({ ok: false });
    expect(parseToolsArgs(['on'])).toMatchObject({ ok: false });
    expect(parseToolsArgs(['off', 'zzz'])).toMatchObject({ ok: false });
  });
  it('models <ia> [<modèle>]', () => {
    expect(parseModelArgs([])).toEqual({ ok: true, value: { model: '' } });
    expect(parseModelArgs(['gemini', 'gemini-2.5-flash'])).toEqual({ ok: true, value: { backend: 'gemini', model: 'gemini-2.5-flash' } });
    expect(parseModelArgs(['llama'])).toMatchObject({ ok: true, value: { backend: 'llamacpp' } });
    expect(parseModelArgs(['claude'])).toMatchObject({ ok: false });
  });
  it('plus de commandes en double dans la TUI', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain('/discover');
    for (const gone of ['/model', '/status', '/quit', '/permission']) expect(names).not.toContain(gone);
    expect(new Set(names).size).toBe(names.length);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { appendContext, contextReference, readContext, resetContext } from '../src/exec/context.js';
import { defaultCfg, targetsOf, tempHome } from './helpers.js';

describe('contexte partagé entre outils (.md)', () => {
  beforeAll(() => {
    process.env.CODEBREAK_HOME = tempHome();
  });

  const cfg = defaultCfg();
  const targets = targetsOf(cfg);
  const cwd = '/tmp/mon-projet';

  it('vide au départ : pas de référence, pas de contenu', () => {
    resetContext(cwd);
    expect(readContext(cwd, cfg)).toBe('');
    expect(contextReference(cwd, cfg)).toBe('');
  });

  it('un tour ajouté apparaît dans le fichier et déclenche une référence courte', () => {
    appendContext(cwd, cfg, {
      target: targets['claude:sonnet']!,
      prompt: 'ajoute un test pour la fonction parse()',
      summary: "J'ai ajouté test/parse.test.ts avec 3 cas.",
      filesChanged: ['test/parse.test.ts'],
    });
    const content = readContext(cwd, cfg);
    expect(content).toContain('## Tour 1 — Claude Sonnet');
    expect(content).toContain('test/parse.test.ts');
    const ref = contextReference(cwd, cfg);
    expect(ref).not.toBe('');
    expect(ref.length).toBeLessThan(400); // référence courte, pas tout l'historique en clair
  });

  it('les tours s’accumulent et se numérotent en continu', () => {
    appendContext(cwd, cfg, {
      target: targets['ollama:ministral-3:8b']!,
      prompt: 'corrige le lint',
      summary: 'lint corrigé',
      filesChanged: [],
    });
    const content = readContext(cwd, cfg);
    expect(content).toContain('## Tour 2 — Ollama ministral-3:8b');
  });

  it('purge les tours les plus anciens au-delà de max_entries', () => {
    resetContext(cwd);
    const small = defaultCfg();
    (small as unknown as { context: { max_entries: number } }).context.max_entries = 2;
    for (let i = 0; i < 5; i++) {
      appendContext(cwd, small, { target: targets['claude:haiku']!, prompt: `tâche ${i}`, summary: '', filesChanged: [] });
    }
    const content = readContext(cwd, small);
    expect(content).not.toContain('tâche 0');
    expect(content).not.toContain('tâche 1');
    expect(content).not.toContain('tâche 2');
    expect(content).toContain('tâche 3');
    expect(content).toContain('tâche 4');
    expect(content).toContain('## Tour 5');
  });

  it('désactivé par config : ni fichier ni référence', () => {
    const off = defaultCfg();
    (off as unknown as { context: { enabled: boolean } }).context.enabled = false;
    const dir = '/tmp/mon-projet-off';
    resetContext(dir);
    appendContext(dir, off, { target: targets['claude:haiku']!, prompt: 'x', summary: 'y', filesChanged: [] });
    expect(readContext(dir, off)).toBe('');
    expect(contextReference(dir, off)).toBe('');
  });

  it('clear vide le fichier', () => {
    resetContext(cwd);
    expect(readContext(cwd, cfg)).toBe('');
  });
});

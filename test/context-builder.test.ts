import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContext, pathsIn, terms } from '../src/memory/context-builder.js';
import { ensureMemory } from '../src/memory/layout.js';
import { TaskRecorder } from '../src/memory/recorder.js';
import { defaultCfg } from './helpers.js';

const cfg = defaultCfg();
const NOW = Date.parse('2026-09-24T12:00:00Z');

function project(files: Partial<Record<'context' | 'decisions' | 'architecture' | 'failures', string>> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cb-ctx-'));
  const p = ensureMemory(cwd, cfg)!;
  for (const [k, v] of Object.entries(files)) writeFileSync(p[k as keyof typeof p] as string, v!);
  return { cwd, p };
}

const CONTEXT = '# Project context\n\n## Goal\nA CLI that routes coding tasks.\n\n## Constraints\nNever edit dist/. Use pnpm.\n\n## Commands\npnpm test\n';
const DECISIONS =
  '# Decisions\n\n' +
  '## 2026-09-10 · OAuth uses PKCE only\ntags: oauth, auth, google\nfiles: src/auth/google.ts\nImplicit flow is forbidden.\n\n' +
  '## 2026-08-01 · Charts use Recharts\ntags: dashboard, charts\nKeep bundle small.\n\n' +
  '## 2026-01-01 · Naming\n<!-- pin -->\nUse camelCase everywhere.\n';
const FAILURES =
  '# Failures\n\n' +
  '## 2026-09-20 12:00 · t1 · attempt 1 · ollama:m\n- kind: typecheck\n- task: Add Google OAuth login\n- files: src/auth/google.ts\n- summary: TS2345 in google.ts\n\n' +
  '## 2026-09-21 09:00 · t2 · attempt 1 · ollama:m\n- kind: test\n- task: Fix pagination of the users table\n- summary: 3 failing tests\n';

describe('Context Builder', () => {
  it('extraction de mots significatifs et de chemins', () => {
    expect(terms('Add the Google OAuth logins to src/auth/google.ts')).toEqual(expect.arrayContaining(['google', 'oauth', 'login', 'src', 'auth']));
    expect(terms('the and for')).toEqual([]);
    expect(pathsIn('edit src/auth/google.ts and README.md, not dist')).toEqual(['src/auth/google.ts', 'README.md']);
  });

  it('inclut le permanent, les décisions et échecs pertinents, exclut le hors-sujet', () => {
    const { cwd } = project({ context: CONTEXT, decisions: DECISIONS, failures: FAILURES });
    const pack = buildContext(cwd, cfg, 'Add Google OAuth login with the callback in src/auth/google.ts', { now: NOW });
    const inc = pack.items.filter((i) => i.included).map((i) => `${i.kind}:${i.heading}`);
    expect(inc).toEqual(expect.arrayContaining(['goal:Goal', 'constraints:Constraints', 'commands:Commands']));
    expect(inc.some((i) => i.startsWith('decision:2026-09-10'))).toBe(true);
    expect(inc.some((i) => i.startsWith('failure:') && i.includes('t1'))).toBe(true);
    // hors-sujet : graphiques et pagination
    expect(pack.items.find((i) => i.heading.includes('Recharts'))).toMatchObject({ included: false, reason: { code: 'below_threshold' } });
    expect(pack.items.find((i) => i.heading.includes('t2'))).toMatchObject({ included: false });
    expect(pack.text).toContain('Implicit flow is forbidden');
    expect(pack.text).not.toContain('Keep bundle small');
    expect(pack.text).toContain('src/auth/google.ts');
  });

  it('une entrée épinglée est toujours incluse ; une correspondance de fichier est expliquée', () => {
    const { cwd } = project({ context: CONTEXT, decisions: DECISIONS });
    const pack = buildContext(cwd, cfg, 'refactor the billing module', { now: NOW });
    expect(pack.items.find((i) => i.heading === '2026-01-01 · Naming')).toMatchObject({ included: true, reason: { code: 'pinned' } });
    const pack2 = buildContext(cwd, cfg, 'tweak src/auth/google.ts', { now: NOW });
    expect(pack2.items.find((i) => i.heading.includes('PKCE'))).toMatchObject({ included: true, reason: { code: 'file_match', files: ['src/auth/google.ts'] } });
  });

  it('une tâche déjà échouée (titre très proche) remonte son échec', () => {
    const { cwd } = project({ failures: FAILURES });
    const pack = buildContext(cwd, cfg, 'Add Google OAuth login', { now: NOW });
    expect(pack.items.find((i) => i.kind === 'failure' && i.included)).toMatchObject({ reason: { code: 'similar_failure' } });
    expect(pack.counts.failures).toBe(1);
  });

  it('ignore les modèles vides : aucun contexte, aucun texte', () => {
    const { cwd } = project();
    const pack = buildContext(cwd, cfg, 'anything at all', { now: NOW });
    expect(pack.text).toBe('');
    expect(pack.items.every((i) => !i.included)).toBe(true);
    expect(pack.items.find((i) => i.heading === 'Goal')).toMatchObject({ reason: { code: 'placeholder' } });
  });

  it('respecte le budget de caractères et explique ce qui est écarté', () => {
    const big = Array.from({ length: 20 }, (_, i) => `## 2026-09-0${(i % 9) + 1} · oauth rule ${i}\ntags: oauth\n${'oauth detail '.repeat(60)}`).join('\n\n');
    const { cwd } = project({ context: CONTEXT, decisions: `# Decisions\n\n${big}\n` });
    const small = { ...cfg, memory: { ...cfg.memory, max_context_chars: 1500, max_decisions: 20 } };
    const pack = buildContext(cwd, small, 'implement oauth', { now: NOW });
    expect(pack.usedChars).toBeLessThanOrEqual(1500);
    expect(pack.items.some((i) => i.reason.code === 'over_budget')).toBe(true);
    expect(pack.items.filter((i) => i.included).length).toBeGreaterThan(1);
  });

  it('reprend la dernière vérification et l’état courant', () => {
    const { cwd } = project({ context: CONTEXT });
    const rec = TaskRecorder.create({ cwd, cfg, id: 'v0000001', prompt: 'previous work', escalation: ['a:b'] })!;
    rec.attemptStarted(1, { id: 'a:b', label: 'A' });
    rec.verify(1, [{ command: 'npm run -s typecheck', ok: true, ms: 10 }, { command: 'npm run -s test', ok: false, ms: 20 }]);
    rec.attemptFinished(1, { ok: false, filesChanged: ['x.ts'] });
    rec.finish('failed');
    const pack = buildContext(cwd, cfg, 'continue the work', { now: NOW });
    expect(pack.text).toMatch(/Latest verification[\s\S]*✓ npm run -s typecheck · ✗ npm run -s test/);
    expect(pack.items.some((i) => i.kind === 'state' && i.included)).toBe(true);
  });

  it('est déterministe et masque les secrets', () => {
    const secret = 'ghp_' + 'Zz19'.repeat(10);
    const { cwd } = project({ context: `${CONTEXT}\n## Notes\ntags: deploy\nToken for deploy is ${secret}\n`, decisions: DECISIONS });
    const a = buildContext(cwd, cfg, 'deploy the oauth service', { now: NOW });
    const b = buildContext(cwd, cfg, 'deploy the oauth service', { now: NOW });
    expect(a.text).toBe(b.text);
    expect(a.text).not.toContain(secret);
  });

  it('mémoire absente ou désactivée : paquet vide', () => {
    expect(buildContext(mkdtempSync(join(tmpdir(), 'cb-none-')), cfg, 'x').text).toBe('');
    const { cwd } = project({ context: CONTEXT });
    expect(buildContext(cwd, { ...cfg, memory: { ...cfg.memory, enabled: false } }, 'x').text).toBe('');
  });
});

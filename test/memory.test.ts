import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMemory, memoryPaths } from '../src/memory/layout.js';
import { isPlaceholder, parseEntries, renderEntry } from '../src/memory/md.js';
import { listManifests, loadManifest, parseManifest, serializeManifest } from '../src/memory/manifest.js';
import { TaskRecorder } from '../src/memory/recorder.js';
import { containsSecret, redact } from '../src/util/redact.js';
import { defaultCfg } from './helpers.js';

const cfg = defaultCfg();
const tmp = () => mkdtempSync(join(tmpdir(), 'cb-mem-'));
// jetons synthétiques construits à l'exécution (aucun secret réel dans le dépôt)
const fake = {
  anthropic: 'sk-ant-' + 'a1B2c3D4'.repeat(4),
  openai: 'sk-' + 'x9Y8z7'.repeat(6),
  github: 'ghp_' + 'Ab12'.repeat(10),
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fwpM',
};

describe('redaction des secrets', () => {
  it('masque les clés et jetons courants', () => {
    for (const [name, value] of Object.entries(fake)) {
      const out = redact(`value is ${value} here`, { values: [] });
      expect(out, name).not.toContain(value);
      expect(out, name).toContain('[REDACTED:');
    }
  });
  it('masque en-têtes Authorization, cookies, URL avec identifiants et affectations NOM=valeur', () => {
    const out = redact(
      'Authorization: Bearer abcdefghijklmnop123456\nCookie: sid=abc123; theme=dark\nfetch https://user:hunter2pass@host.test/x\nAPI_KEY=supersecretvalue\n{"password": "correct-horse-battery"}',
      { values: [] },
    );
    expect(out).not.toMatch(/abcdefghijklmnop123456|sid=abc123|hunter2pass|supersecretvalue|correct-horse-battery/);
  });
  it('masque un bloc de clé privée', () => {
    const out = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nok', { values: [] });
    expect(out).toBe('[REDACTED:private-key]\nok');
  });
  it('masque les valeurs secrètes de l’environnement', () => {
    const out = redact('the token is Zm9vYmFyYmF6cXV4 today', { values: ['Zm9vYmFyYmF6cXV4'] });
    expect(out).toBe('the token is [REDACTED:env] today');
  });
  it('ne touche pas au texte ordinaire ni au code', () => {
    const src = 'error TS2322: Type string is not assignable\n  at src/a.ts:12:5\ntokenize(input) // tokens: 12';
    expect(redact(src, { values: [] })).toBe(src);
    expect(containsSecret('nothing to see', { values: [] })).toBe(false);
  });
});

describe('disposition .codebreak/', () => {
  it('crée les fichiers, un .gitignore et reste idempotent sans écraser', () => {
    const cwd = tmp();
    const p = ensureMemory(cwd, cfg)!;
    for (const f of [p.context, p.state, p.architecture, p.decisions, p.failures, p.tasks, p.gitignore]) expect(existsSync(f), f).toBe(true);
    expect(readFileSync(p.gitignore, 'utf8')).toMatch(/sessions\//);
    writeFileSync(p.context, '# mine\n\n## Goal\nMy real goal\n');
    ensureMemory(cwd, cfg);
    expect(readFileSync(p.context, 'utf8')).toContain('My real goal');
  });
  it('désactivable, et auto_init=false ne crée rien', () => {
    expect(ensureMemory(tmp(), { ...cfg, memory: { ...cfg.memory, enabled: false } })).toBeNull();
    const cwd = tmp();
    expect(ensureMemory(cwd, { ...cfg, memory: { ...cfg.memory, auto_init: false } })).toBeNull();
    expect(existsSync(join(cwd, '.codebreak'))).toBe(false);
  });
  it('les modèles vides sont reconnus comme des textes d’exemple', () => {
    const cwd = tmp();
    const p = ensureMemory(cwd, cfg)!;
    const entries = parseEntries(readFileSync(p.context, 'utf8'));
    expect(entries.map((e) => e.heading)).toEqual(['Goal', 'Constraints', 'Commands']);
    expect(entries.every((e) => isPlaceholder(e.body))).toBe(true);
    expect(isPlaceholder('Use pnpm, never npm.')).toBe(false);
  });
  it('lit les entrées avec métadonnées, date et épinglage', () => {
    const md = '# Decisions\n\n## 2026-09-01 · Use zod\ntags: config, validation\nfiles: src/config/schema.ts\nBecause it is typed.\n\n## Pinned rule\n<!-- pin -->\nNever edit dist/.\n';
    const [a, b] = parseEntries(md);
    expect(a).toMatchObject({ heading: '2026-09-01 · Use zod', date: '2026-09-01', meta: { tags: 'config, validation', files: 'src/config/schema.ts' } });
    expect(b!.pinned).toBe(true);
    expect(renderEntry('h', ['a: 1'], 'x```y')).toContain("x'''y");
  });
});

describe('manifeste de tâche', () => {
  it('aller-retour YAML + corps, notes humaines conservées', () => {
    const cwd = tmp();
    const p = ensureMemory(cwd, cfg)!;
    const rec = TaskRecorder.create({ cwd, cfg, id: 'abc12345', prompt: 'Add Google OAuth\nwith PKCE', escalation: ['ollama:qwen3:8b', 'claude:sonnet'] })!;
    const path = join(p.tasksDir, 'abc12345.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/## Notes[\s\S]*$/, '## Notes\nMy own remark\n'));
    rec.finish('done');
    const m = loadManifest(p, 'abc12345')!;
    expect(m).toMatchObject({ id: 'abc12345', task: 'Add Google OAuth', status: 'done', allowed_agents: ['ollama', 'claude'] });
    expect(m.objective).toBe('Add Google OAuth\nwith PKCE');
    expect(m.notes).toBe('My own remark');
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
  it('rejette un fichier sans frontmatter', () => {
    expect(parseManifest('# just markdown')).toBeNull();
  });
});

describe('TaskRecorder', () => {
  const setup = () => {
    const cwd = tmp();
    const rec = TaskRecorder.create({ cwd, cfg, id: 'tid00001', prompt: 'Fix the login bug', escalation: ['ollama:m', 'claude:sonnet'] })!;
    return { cwd, rec, p: memoryPaths(cwd, cfg) };
  };

  it('écrit chronologie (md + jsonl), échecs, état et index', () => {
    const { rec, p } = setup();
    rec.attemptStarted(1, { id: 'ollama:m', label: 'Ollama m' }, 'snapA');
    rec.verify(1, [{ command: 'npm run -s typecheck', ok: false, ms: 900, exitCode: 2 }]);
    rec.failure(1, { kind: 'typecheck', fingerprint: 'fp1', summary: '2 errors (TS2322)', command: 'npm run -s typecheck' }, { files: ['src/a.ts'], output: 'error TS2322 at src/a.ts' });
    rec.attemptFinished(1, { ok: false, filesChanged: ['src/a.ts'], durationMs: 1200 });
    rec.decision(1, { action: 'escalate', reason: 'same error twice', to: 'claude:sonnet' });
    rec.finish('failed', 'gave up');

    const failures = readFileSync(p.failures, 'utf8');
    expect(failures).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · tid00001 · attempt 1 · ollama:m/);
    expect(failures).toContain('kind: typecheck');
    expect(readFileSync(p.state, 'utf8')).toMatch(/Last task:\*\* Fix the login bug .*failed/);
    expect(readFileSync(p.tasks, 'utf8')).toContain('| `tid00001` | failed |');
    const timeline = TaskRecorder.readTimeline(p, 'tid00001');
    expect(timeline.map((e) => e.kind)).toEqual(['task_started', 'attempt_started', 'verify', 'diagnosis', 'attempt_finished', 'decision', 'task_finished']);
    expect(listManifests(p)[0]!.attempts[0]!.next).toMatchObject({ action: 'escalate', to: 'claude:sonnet' });
  });

  it('ne laisse jamais fuiter un secret dans les fichiers', () => {
    const cwd = tmp();
    const rec = TaskRecorder.create({ cwd, cfg, id: 'sec00001', prompt: `deploy with ${fake.anthropic}`, escalation: ['claude:sonnet'] })!;
    rec.attemptStarted(1, { id: 'claude:sonnet', label: 'Claude Sonnet' });
    rec.failure(1, { kind: 'test', fingerprint: 'f', summary: `boom ${fake.github}` }, { files: [], output: `Authorization: Bearer ${fake.openai}\nGITHUB_TOKEN=${fake.github}` });
    rec.finish('failed');
    const p = memoryPaths(cwd, cfg);
    const all = [p.failures, p.state, p.tasks, join(p.tasksDir, 'sec00001.md'), join(p.runsDir, 'sec00001.jsonl')].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const secret of [fake.anthropic, fake.github, fake.openai]) expect(all).not.toContain(secret);
    expect(all).toContain('[REDACTED:');
  });

  it('un dossier de mémoire inutilisable ne fait jamais échouer l’exécution', () => {
    const cwd = tmp();
    const rec = TaskRecorder.create({ cwd, cfg, id: 'bad00001', prompt: 'x', escalation: [] })!;
    // le dossier des tâches devient un fichier : toute écriture suivante échoue
    const p = memoryPaths(cwd, cfg);
    writeFileSync(join(p.runsDir, 'bad00001.jsonl'), '');
    mkdirSync(join(p.sessionsDir), { recursive: true });
    expect(() => {
      rec.attemptStarted(1, { id: 'a:b', label: 'A' });
      rec.finish('done');
    }).not.toThrow();
    expect(TaskRecorder.create({ cwd: '/dev/null/nope', cfg, id: 'x', prompt: 'x', escalation: [] })).toBeNull();
  });

  it('retourne null si la mémoire est désactivée', () => {
    expect(TaskRecorder.create({ cwd: tmp(), cfg: { ...cfg, memory: { ...cfg.memory, enabled: false } }, id: 'a', prompt: 'x', escalation: [] })).toBeNull();
  });
});

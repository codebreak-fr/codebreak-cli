import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changesBetween, createWorkSnapshot, diffBetween, pruneSnapshots, rollbackAttempt } from '../src/exec/snapshots.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
const write = (cwd: string, p: string, c: string) => {
  mkdirSync(join(cwd, p, '..'), { recursive: true });
  writeFileSync(join(cwd, p), c);
};
const read = (cwd: string, p: string) => readFileSync(join(cwd, p), 'utf8');

/** dépôt avec un historique et du travail utilisateur non commité (tracked modifié, non suivi, indexé). */
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'cb-snap-'));
  git(cwd, 'init', '-q');
  write(cwd, '.gitignore', 'node_modules\n');
  for (const f of ['a.ts', 'c.ts', 'd.ts', 'staged.ts']) write(cwd, f, `original ${f}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'init');
  // travail de l'utilisateur, avant l'agent
  write(cwd, 'd.ts', 'USER edit of d\n');
  write(cwd, 'e.txt', 'USER untracked e\n');
  write(cwd, 'staged.ts', 'USER staged change\n');
  git(cwd, 'add', 'staged.ts');
  write(cwd, 'node_modules/x/index.js', 'ignored\n');
  return cwd;
}

describe('instantanés Git', () => {
  it('l’instantané ne touche ni l’index, ni le working tree, ni les branches', async () => {
    const cwd = repo();
    const before = { cached: git(cwd, 'diff', '--cached', '--name-only'), status: git(cwd, 'status', '--porcelain'), head: git(cwd, 'rev-parse', 'HEAD'), branches: git(cwd, 'branch') };
    const snap = await createWorkSnapshot(cwd, 'attempt 1');
    expect(snap).not.toBeNull();
    expect(snap!.ref).toMatch(/^refs\/codebreak\/snapshots\//);
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe(before.cached);
    expect(git(cwd, 'status', '--porcelain')).toBe(before.status);
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(git(cwd, 'branch')).toBe(before.branches);
    expect(snap!.dirtyBefore.sort()).toEqual(['d.ts', 'e.txt', 'staged.ts']);
  });

  it('attribue à la tentative uniquement ses changements, jamais le travail préexistant', async () => {
    const cwd = repo();
    const pre = (await createWorkSnapshot(cwd, 'pre'))!;
    write(cwd, 'a.ts', 'AGENT edit of a\n');
    write(cwd, 'src/new.ts', 'AGENT new file\n');
    unlinkSync(join(cwd, 'c.ts'));
    const post = (await createWorkSnapshot(cwd, 'post'))!;
    const changes = await changesBetween(cwd, pre, post);
    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.ts', status: 'M' },
      { path: 'c.ts', status: 'D' },
      { path: 'src/new.ts', status: 'A' },
    ]);
    expect(changes.map((c) => c.path)).not.toEqual(expect.arrayContaining(['d.ts']));
    expect(await diffBetween(cwd, pre, post)).toContain('+AGENT edit of a');
    // aucun changement : liste vide
    expect(await changesBetween(cwd, post, post)).toEqual([]);
  });

  it('rollback : restaure/supprime ce que la tentative a fait, conserve le travail utilisateur', async () => {
    const cwd = repo();
    const pre = (await createWorkSnapshot(cwd, 'pre'))!;
    write(cwd, 'a.ts', 'AGENT edit of a\n');
    write(cwd, 'src/new.ts', 'AGENT new file\n');
    unlinkSync(join(cwd, 'c.ts'));
    const post = (await createWorkSnapshot(cwd, 'post'))!;
    const staged = git(cwd, 'diff', '--cached', '--name-only');

    const r = await rollbackAttempt(cwd, pre, post);
    expect(r.restored.sort()).toEqual(['a.ts', 'c.ts']);
    expect(r.removed).toEqual(['src/new.ts']);
    expect(r.skipped).toEqual([]);
    expect(read(cwd, 'a.ts')).toBe('original a.ts\n');
    expect(read(cwd, 'c.ts')).toBe('original c.ts\n');
    expect(existsSync(join(cwd, 'src/new.ts'))).toBe(false);
    // travail de l'utilisateur intact, index compris
    expect(read(cwd, 'd.ts')).toBe('USER edit of d\n');
    expect(read(cwd, 'e.txt')).toBe('USER untracked e\n');
    expect(read(cwd, 'staged.ts')).toBe('USER staged change\n');
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe(staged);
  });

  it('rollback : n’écrase jamais un fichier modifié après la tentative', async () => {
    const cwd = repo();
    const pre = (await createWorkSnapshot(cwd, 'pre'))!;
    write(cwd, 'a.ts', 'AGENT edit of a\n');
    write(cwd, 'src/new.ts', 'AGENT new file\n');
    const post = (await createWorkSnapshot(cwd, 'post'))!;
    write(cwd, 'a.ts', 'USER kept typing after the agent\n');
    const r = await rollbackAttempt(cwd, pre, post);
    expect(r.skipped).toEqual([{ path: 'a.ts', reason: 'modified_after_attempt' }]);
    expect(read(cwd, 'a.ts')).toBe('USER kept typing after the agent\n');
    expect(r.removed).toEqual(['src/new.ts']);
  });

  it('ignore les fichiers ignorés par Git', async () => {
    const cwd = repo();
    const pre = (await createWorkSnapshot(cwd, 'pre'))!;
    write(cwd, 'node_modules/y/index.js', 'more ignored\n');
    const post = (await createWorkSnapshot(cwd, 'post'))!;
    expect(await changesBetween(cwd, pre, post)).toEqual([]);
  });

  it('dépôt sans aucun commit, et hors dépôt', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cb-empty-'));
    git(empty, 'init', '-q');
    write(empty, 'f.txt', '1\n');
    const pre = (await createWorkSnapshot(empty, 'pre'))!;
    expect(pre.head).toBeNull();
    write(empty, 'g.txt', '2\n');
    const post = (await createWorkSnapshot(empty, 'post'))!;
    expect(await changesBetween(empty, pre, post)).toEqual([{ path: 'g.txt', status: 'A' }]);
    expect(await createWorkSnapshot(mkdtempSync(join(tmpdir(), 'cb-norepo-')), 'x')).toBeNull();
  });

  it('fonctionne depuis un sous-dossier du dépôt', async () => {
    const cwd = repo();
    const pre = (await createWorkSnapshot(cwd, 'pre'))!;
    write(cwd, 'sub/x.ts', 'x\n');
    const post = (await createWorkSnapshot(join(cwd, 'sub'), 'post'))!;
    expect(await changesBetween(join(cwd, 'sub'), pre, post)).toEqual([{ path: 'sub/x.ts', status: 'A' }]);
  });

  it('purge les anciennes références seulement', async () => {
    const cwd = repo();
    await createWorkSnapshot(cwd, 'old');
    expect(await pruneSnapshots(cwd, 14)).toBe(0);
    expect(await pruneSnapshots(cwd, 14, Date.now() + 30 * 864e5)).toBe(1);
    expect(git(cwd, 'for-each-ref', 'refs/codebreak')).toBe('');
  });
});

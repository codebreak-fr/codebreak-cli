import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../util/exec.js';

/**
 * Instantanés de l'arbre de travail, sans jamais toucher à l'index, au working tree ou aux branches de l'utilisateur :
 * l'arbre est construit dans un index temporaire (`GIT_INDEX_FILE`), rangé sous `refs/codebreak/snapshots/*`.
 * Comparer deux instantanés donne exactement ce qu'une tentative a changé ; les modifications déjà présentes avant
 * elle (tracked ou non) sont dans les deux et n'apparaissent donc jamais comme le travail de l'agent.
 */

export interface WorkSnapshot {
  id: string;
  commit: string;
  tree: string;
  head: string | null;
  ref: string;
  /** fichiers déjà modifiés/non suivis avant l'instantané (travail de l'utilisateur) */
  dirtyBefore: string[];
  at: number;
}

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D';
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'CodeBreak',
  GIT_AUTHOR_EMAIL: 'codebreak@localhost',
  GIT_COMMITTER_NAME: 'CodeBreak',
  GIT_COMMITTER_EMAIL: 'codebreak@localhost',
};

const git = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, timeoutMs = 60_000) =>
  exec('git', args, { cwd, timeoutMs, env: { ...process.env, ...extra } });

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);

export async function createWorkSnapshot(cwd: string, label: string, opts: { exclude?: string[] } = {}): Promise<WorkSnapshot | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const headRes = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const head = headRes.code === 0 ? headRes.stdout.trim() : null;

  const dir = mkdtempSync(join(tmpdir(), 'cb-idx-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    // la mémoire de CodeBreak (`.codebreak/`) n'est jamais du « travail de l'agent » ni annulable
    const add = await git(root, ['add', '-A', '--', ':/', ...(opts.exclude ?? []).map((p) => `:(exclude)${p}`)], env);
    if (add.code !== 0) return null;
    const tree = await git(root, ['write-tree'], env);
    if (tree.code !== 0) return null;
    const treeId = tree.stdout.trim();
    const commit = await git(root, ['commit-tree', treeId, ...(head ? ['-p', head] : []), '-m', `codebreak snapshot: ${label}`], IDENTITY);
    if (commit.code !== 0) return null;
    const commitId = commit.stdout.trim();
    const id = `${Date.now().toString(36)}-${safeName(label)}`;
    const ref = `refs/codebreak/snapshots/${id}`;
    const upd = await git(root, ['update-ref', ref, commitId]);
    if (upd.code !== 0) return null;
    const status = await git(root, ['status', '--porcelain=v1', '-uall']);
    const dirtyBefore = status.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
    return { id, commit: commitId, tree: treeId, head, ref, dirtyBefore, at: Date.now() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const root = async (cwd: string) => (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();

/** Fichiers ajoutés / modifiés / supprimés entre deux instantanés. */
export async function changesBetween(cwd: string, a: Pick<WorkSnapshot, 'tree'>, b: Pick<WorkSnapshot, 'tree'>): Promise<FileChange[]> {
  const r = await git(await root(cwd), ['diff-tree', '-r', '--name-status', '--no-renames', '-z', a.tree, b.tree]);
  if (r.code !== 0) return [];
  const parts = r.stdout.split('\0').filter((x) => x !== '');
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.charAt(0);
    if (status === 'A' || status === 'M' || status === 'D') out.push({ path: parts[i + 1]!, status });
  }
  return out;
}

/** Diff unifié entre deux instantanés (borné). */
export async function diffBetween(cwd: string, a: Pick<WorkSnapshot, 'tree'>, b: Pick<WorkSnapshot, 'tree'>, maxChars = 200_000): Promise<string> {
  const r = await git(await root(cwd), ['diff', '--no-color', '--no-renames', a.tree, b.tree]);
  return r.code === 0 ? r.stdout.slice(0, maxChars) : '';
}

export interface RollbackResult {
  restored: string[];
  removed: string[];
  skipped: { path: string; reason: 'modified_after_attempt' | 'failed' }[];
}

/**
 * Annule uniquement ce que la tentative `pre → post` a changé. Un fichier que l'utilisateur (ou un autre processus) a
 * modifié depuis la fin de la tentative n'est jamais écrasé. Le travail antérieur à la tentative est intact : on
 * restaure l'état de `pre`, qui l'inclut déjà.
 */
export async function rollbackAttempt(cwd: string, pre: WorkSnapshot, post: WorkSnapshot): Promise<RollbackResult> {
  const top = await root(cwd);
  const result: RollbackResult = { restored: [], removed: [], skipped: [] };
  const { unlinkSync, existsSync } = await import('node:fs');
  for (const ch of await changesBetween(cwd, pre, post)) {
    const abs = join(top, ch.path);
    const exists = existsSync(abs);
    // l'état courant doit être celui laissé par la tentative
    if (ch.status === 'D') {
      if (exists) {
        result.skipped.push({ path: ch.path, reason: 'modified_after_attempt' });
        continue;
      }
    } else {
      if (!exists) {
        result.skipped.push({ path: ch.path, reason: 'modified_after_attempt' });
        continue;
      }
      const now = (await git(top, ['hash-object', '--', ch.path])).stdout.trim();
      const expected = (await git(top, ['rev-parse', `${post.commit}:${ch.path}`])).stdout.trim();
      if (now !== expected) {
        result.skipped.push({ path: ch.path, reason: 'modified_after_attempt' });
        continue;
      }
    }
    if (ch.status === 'A') {
      try {
        unlinkSync(abs);
        result.removed.push(ch.path);
      } catch {
        result.skipped.push({ path: ch.path, reason: 'failed' });
      }
    } else {
      // --worktree seul : l'index de l'utilisateur n'est pas modifié
      const r = await git(top, ['restore', `--source=${pre.commit}`, '--worktree', '--', ch.path]);
      if (r.code === 0) result.restored.push(ch.path);
      else result.skipped.push({ path: ch.path, reason: 'failed' });
    }
  }
  return result;
}

/** Supprime les références d'instantanés plus anciennes que `olderThanDays` (les objets partent au prochain `git gc`). */
export async function pruneSnapshots(cwd: string, olderThanDays = 14, now = Date.now()): Promise<number> {
  const top = await root(cwd);
  if (!top) return 0;
  const r = await git(top, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/codebreak/snapshots']);
  let n = 0;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [ref, ts] = line.split(' ');
    if (ref && ts && now - Number(ts) * 1000 > olderThanDays * 864e5) {
      if ((await git(top, ['update-ref', '-d', ref])).code === 0) n++;
    }
  }
  return n;
}

import { createHash } from 'node:crypto';
import { exec } from '../util/exec.js';

export interface GitSnapshot {
  isRepo: boolean;
  /** empreinte de l'état du dépôt (statut + diff) */
  signature: string;
  files: string[];
}

export async function snapshot(cwd: string): Promise<GitSnapshot> {
  const status = await exec('git', ['status', '--porcelain=v1', '-uall'], { cwd, timeoutMs: 10_000 });
  if (status.code !== 0) return { isRepo: false, signature: '', files: [] };
  const diff = await exec('git', ['diff', 'HEAD'], { cwd, timeoutMs: 15_000 });
  const files = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim());
  const signature = createHash('sha1')
    .update(status.stdout)
    .update(diff.stdout.slice(0, 2_000_000))
    .digest('hex');
  return { isRepo: true, signature, files };
}

/**
 * Repli quand les instantanés d'arbre ne sont pas disponibles : fichiers devenus modifiés/non suivis depuis `before`.
 * Sous-estime (un fichier déjà modifié puis re-modifié n'apparaît pas) mais n'attribue jamais à l'agent le travail
 * que l'utilisateur avait déjà en cours.
 */
export const changedFiles = (before: GitSnapshot, after: GitSnapshot): string[] =>
  before.signature === after.signature ? [] : after.files.filter((f) => !before.files.includes(f));

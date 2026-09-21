import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Detection } from '../detect/types.js';
import type { CatalogModel } from './types.js';

export const hfCacheDir = () => process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub');

/** Dossier du cache HF d'un dépôt (`org/name` → `models--org--name`). */
export const hfRepoDir = (repo: string, root = hfCacheDir()) => join(root, `models--${repo.replace(/\//g, '--')}`);

/** Un modèle du catalogue est-il déjà installé ? La détection (`cb detect`) fait foi pour Ollama. */
export function isInstalled(model: CatalogModel, det: Detection, hfRoot = hfCacheDir()): boolean {
  if (model.runtime === 'ollama') {
    const base = (n: string) => (n.includes(':') ? n : `${n}:latest`);
    return det.ollama.models.some((m) => base(m.name) === base(model.name));
  }
  return existsSync(hfRepoDir(model.name, hfRoot));
}

/** Taille réelle d'un dépôt du cache HF : on ne compte que `blobs/` (les snapshots n'en sont que des liens). */
export function dirSizeGB(dir: string): number {
  const blobs = join(dir, 'blobs');
  if (existsSync(blobs)) dir = blobs;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          bytes += statSync(p).size; // suit les liens symboliques vers les blobs
        } catch {
          /* lien cassé */
        }
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return bytes / 1024 ** 3;
}

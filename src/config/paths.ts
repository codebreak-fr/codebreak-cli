import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** CODEBREAK_HOME regroupe config et état dans un seul dossier (tests, portable). */
export function configDir(): string {
  if (process.env.CODEBREAK_HOME) return join(process.env.CODEBREAK_HOME, 'config');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'codebreak');
}

export function stateDir(): string {
  if (process.env.CODEBREAK_HOME) return join(process.env.CODEBREAK_HOME, 'state');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codebreak');
}

export const globalConfigPath = () => join(configDir(), 'config.yaml');
export const projectConfigPath = (cwd: string) => join(cwd, '.codebreak.yaml');
export const ledgerPath = () => join(stateDir(), 'ledger.jsonl');
export const usageCachePath = () => join(stateDir(), 'claude-usage.json');
export const classifierCachePath = () => join(stateDir(), 'classifier-cache.json');
export const historyPath = () => join(stateDir(), 'prompt-history.json');

/**
 * Fichier de contexte partagé entre outils, un par projet (nom dérivé du chemin).
 * Volontairement hors du dépôt (état de CodeBreak, pas un fichier à committer).
 */
export function contextFilePath(cwd: string): string {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 10);
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'projet';
  return join(stateDir(), 'context', `${base}-${hash}.md`);
}
export const catalogCachePath = () => join(stateDir(), 'catalog-cache.json');
/** Modèles installés via Discovery, avec leur adéquation matérielle : point d'entrée du futur routage. */
export const modelRegistryPath = () => join(stateDir(), 'model-registry.json');
export const usageIncidentsPath = () => join(stateDir(), 'usage-incidents.json');
export const benchCachePath = () => join(stateDir(), 'bench-cache.json');

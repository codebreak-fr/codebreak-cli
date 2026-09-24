import type { Config } from '../config/schema.js';
import { defaultModelInfo, modelDefaultWrites } from '../router/targets.js';
import type { RemoveRef } from './installer.js';

/** Écritures de config pour utiliser ce modèle comme défaut local ; `null` si le routeur ne le pilote pas. */
export function useModelWrites(m: Pick<RemoveRef, 'runtime' | 'name'>, cfg: Config): [string, unknown][] | null {
  return m.runtime === 'ollama' ? modelDefaultWrites('ollama', m.name, cfg) : null;
}

/** Après une suppression : remet à `auto` le modèle par défaut s'il pointait sur le modèle supprimé. */
export function afterRemoveWrites(m: Pick<RemoveRef, 'runtime' | 'name'>, cfg: Config): [string, unknown][] {
  if (m.runtime !== 'ollama') return [];
  const info = defaultModelInfo('ollama', cfg);
  return info.value === m.name ? [[info.key, '']] : [];
}

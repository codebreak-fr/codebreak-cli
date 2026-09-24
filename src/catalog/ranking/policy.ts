import type { Config } from '../../config/schema.js';
import type { Detection } from '../../detect/types.js';
import { monthsBetween } from '../sources/http.js';
import type { CatalogModel, ExcludeReason } from '../types.js';

/** Le runtime du modèle est-il utilisable tout de suite sur cette machine ? */
export function runtimeAvailable(model: CatalogModel, det: Detection): boolean {
  switch (model.runtime) {
    case 'ollama':
      return det.ollama.installed;
    case 'mlx':
      return det.hardware.appleSilicon && (det.huggingface.installed || det.hardware.mlx.pythonMlx);
    case 'huggingface':
      return det.huggingface.installed;
  }
}

/** Le routeur CodeBreak pilote-t-il ce runtime ? (Ollama uniquement pour l'instant.) */
export const isRoutable = (model: Pick<CatalogModel, 'runtime'>): boolean => model.runtime === 'ollama';

/** Âge (mois) d'un modèle d'après sa date de sortie, à défaut de sa dernière mise à jour. */
export function ageMonths(model: CatalogModel, now: number): number | undefined {
  return monthsBetween(model.releaseDate ?? model.lastUpdated, now);
}

/**
 * Filtres « modernité et sérieux » appliqués avant tout scoring : trop ancien, sans traction suffisante,
 * runtime absent. La date seule ne suffit jamais à qualifier un modèle : le scoring vient après.
 */
export function gate(model: CatalogModel, det: Detection, cfg: Config, now: number): ExcludeReason | null {
  const d = cfg.discovery;
  if (!runtimeAvailable(model, det)) return 'runtime-missing';
  const age = ageMonths(model, now);
  if (age === undefined || age > d.max_age_months) return 'stale';
  // Hugging Face est bien plus bruité que le registre Ollama : traction exigée plus haute
  const minDownloads = model.source === 'ollama' ? d.min_downloads : d.min_downloads * 4;
  const traction = (model.downloads ?? 0) >= minDownloads || (model.likes ?? 0) >= (model.source === 'ollama' ? 10 : 50);
  if (!traction) return 'low-signal';
  return null;
}

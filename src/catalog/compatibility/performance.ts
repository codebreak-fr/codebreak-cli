import type { HardwareInfo } from '../../detect/types.js';
import { CATEGORY_BY_ID } from '../categories.js';
import type { CatalogModel, CategoryId, Performance } from '../types.js';

/** Part de la bande passante mémoire effectivement exploitée à la génération (valeur empirique). */
const BANDWIDTH_EFFICIENCY = 0.6;

/**
 * Débit estimé : la génération d'un LLM est limitée par la bande passante mémoire (tokens/s ≈ bande passante / octets lus
 * par token). Sans bande passante connue, on ne devine pas : `undefined`. Pour STT/TTS/image/vidéo, aucune formule
 * fiable n'existe à partir de la seule taille : inconnu.
 */
export function estimatePerformance(model: CatalogModel, category: CategoryId, hw: HardwareInfo): Performance | undefined {
  const kind = CATEGORY_BY_ID[category].kind;
  if (kind !== 'llm' && kind !== 'embedding') return undefined;
  if (model.sizeGB === undefined || !hw.bandwidthGBps) return undefined;
  // MoE : seuls les experts actifs sont lus à chaque token
  const active = model.activeParamsB && model.paramsB ? Math.max(0.05, model.sizeGB * (model.activeParamsB / model.paramsB)) : model.sizeGB;
  const value = (hw.bandwidthGBps * BANDWIDTH_EFFICIENCY) / active;
  return { value: Math.round(value * 10) / 10, unit: kind === 'llm' ? 'tok/s' : 'passes/s', estimated: true };
}

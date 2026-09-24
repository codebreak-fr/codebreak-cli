import { providerKey } from '../providers.js';
import type { Recommendation } from '../types.js';

export const MAX_RECOMMENDED = 3;

const byScore = (a: Recommendation, b: Recommendation) => b.scores.total - a.scores.total;

/**
 * Sélection finale, après scoring :
 *  1. un seul modèle par fournisseur (le meilleur modèle non-lent de chacun) ;
 *  2. au plus `MAX_RECOMMENDED` modèles 🟢/🟡 ;
 *  3. au plus UN modèle 🐢, d'un fournisseur absent de la sélection.
 * Ne complète jamais artificiellement la liste.
 */
export function selectDiverse(candidates: Recommendation[], max = MAX_RECOMMENDED): { recommended: Recommendation[]; slow: Recommendation | null } {
  const bestPerProvider = new Map<string, Recommendation>();
  for (const r of [...candidates].filter((c) => c.verdict !== 'slow').sort(byScore)) {
    const k = providerKey(r.model.provider);
    if (!bestPerProvider.has(k)) bestPerProvider.set(k, r);
  }
  const recommended = [...bestPerProvider.values()].sort(byScore).slice(0, max);
  const used = new Set(recommended.map((r) => providerKey(r.model.provider)));
  const slow = candidates
    .filter((c) => c.verdict === 'slow' && !used.has(providerKey(c.model.provider)))
    .sort(byScore)[0] ?? null;
  return { recommended, slow };
}

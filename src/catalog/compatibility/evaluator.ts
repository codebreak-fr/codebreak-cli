import type { Config } from '../../config/schema.js';
import type { HardwareInfo } from '../../detect/types.js';
import { CATEGORY_BY_ID } from '../categories.js';
import type { CatalogModel, CategoryId, Fit, MemoryBreakdown, Verdict } from '../types.js';
import { memoryFor } from './memory.js';
import { estimatePerformance } from './performance.js';

const RANK: Record<Exclude<Verdict, 'excluded'>, number> = { recommended: 3, alternative: 2, slow: 1 };
const worst = (a: Exclude<Verdict, 'excluded'>, b: Exclude<Verdict, 'excluded'>) => (RANK[a] <= RANK[b] ? a : b);

/** Verdict mémoire seul : la marge de sécurité est toujours exigée, sauf à moitié pour la zone 🐢. */
export function memoryVerdict(m: MemoryBreakdown, cfg: Config): Exclude<Verdict, 'excluded'> | null {
  const d = cfg.discovery;
  const safe = m.neededGB + m.headroomGB <= m.budgetGB;
  if (m.ratio <= d.comfort_ratio && safe) return 'recommended';
  if (m.ratio <= d.alternative_ratio && safe) return 'alternative';
  if (m.ratio <= d.slow_ratio && m.neededGB + m.headroomGB * 0.5 <= m.budgetGB) return 'slow';
  return null;
}

/**
 * Compatibilité matériel × modèle, sans aucune dépendance à l'UI :
 * `recommended` (🟢) / `alternative` (🟡) / `slow` (🐢) / `excluded` (🔴).
 */
export function evaluateFit(model: CatalogModel, category: CategoryId, hw: HardwareInfo, cfg: Config): Fit {
  const memory = memoryFor(model, category, hw, cfg);
  if (!memory) {
    return { verdict: 'excluded', reason: 'unknown-size', memory: { weightsGB: 0, kvCacheGB: 0, overheadGB: 0, neededGB: 0, headroomGB: 0, budgetGB: 0, pool: 'ram', ratio: Infinity } };
  }
  const performance = estimatePerformance(model, category, hw);
  const excluded = (reason: NonNullable<Fit['reason']>): Fit => ({ verdict: 'excluded', reason, memory, performance });

  const def = CATEGORY_BY_ID[category];
  // génération d'image/vidéo sur CPU seul : durées absurdes, jamais recommandé
  if (def.kind === 'diffusion' && hw.backend === 'cpu') return excluded('wrong-hardware');

  let verdict = memoryVerdict(memory, cfg);
  if (!verdict) return excluded('too-heavy');

  const d = cfg.discovery;
  if (def.kind === 'llm') {
    const tps = performance?.value;
    if (tps === undefined) verdict = worst(verdict, 'alternative'); // vitesse invérifiable : jamais « recommandé »
    else if (tps < d.slow_tps) return excluded('too-slow');
    else if (tps < d.min_tps) verdict = worst(verdict, 'slow');
  }
  return { verdict, memory, performance };
}

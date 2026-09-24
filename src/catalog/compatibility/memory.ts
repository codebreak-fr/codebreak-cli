import type { Config } from '../../config/schema.js';
import type { HardwareInfo } from '../../detect/types.js';
import { CATEGORY_BY_ID } from '../categories.js';
import type { CatalogModel, CategoryId, MemoryBreakdown } from '../types.js';

export type Pool = MemoryBreakdown['pool'];

/** Mémoire réellement utilisable pour un modèle : VRAM d'un GPU dédié, mémoire unifiée Apple, ou RAM. */
export function memoryBudget(hw: HardwareInfo, cfg: Config): { pool: Pool; budgetGB: number } {
  const d = cfg.discovery;
  if (hw.appleSilicon) return { pool: 'unified', budgetGB: hw.memoryGB * d.unified_memory_ratio };
  if (hw.vramGB > 0) {
    // plusieurs GPU : la répartition des couches coûte ~10 % de mémoire utile
    const split = hw.gpus.length > 1 ? 0.9 : 1;
    return { pool: 'vram', budgetGB: hw.vramGB * split };
  }
  return { pool: 'ram', budgetGB: hw.memoryGB * d.cpu_memory_ratio };
}

/** Surcoût mémoire fixe du runtime (Go) et multiplicateur de marge de sécurité, par runtime. */
const RUNTIME = {
  ollama: { overheadGB: 0.4, headroom: 1 },
  mlx: { overheadGB: 0.3, headroom: 1 },
  huggingface: { overheadGB: 0.8, headroom: 1.25 }, // pile Python (torch/transformers), plus gourmande et moins prévisible
} as const;

/** Octets de KV cache par token (Mo), estimés d'après la taille : ~0,11 Mo pour 8B, croissance sous-linéaire. */
const kvMBPerToken = (paramsB: number) => 0.11 * Math.pow(Math.max(paramsB, 0.1) / 8, 0.6);

export function memoryFor(model: CatalogModel, category: CategoryId, hw: HardwareInfo, cfg: Config): MemoryBreakdown | null {
  if (model.sizeGB === undefined) return null;
  const def = CATEGORY_BY_ID[category];
  const d = cfg.discovery;
  const { pool, budgetGB } = memoryBudget(hw, cfg);
  const rt = RUNTIME[model.runtime];

  const weightsGB = model.sizeGB;
  let kvCacheGB = 0;
  if (def.kind === 'llm') {
    const paramsB = model.paramsB ?? weightsGB / 0.6;
    const ctx = Math.min(d.context_tokens, model.contextLength ?? d.context_tokens);
    kvCacheGB = (kvMBPerToken(paramsB) * ctx) / 1024;
  }
  const overheadGB = def.fixedOverheadGB + weightsGB * def.activationFactor + rt.overheadGB;
  const neededGB = weightsGB + kvCacheGB + overheadGB;
  const headroomGB = Math.max(d.headroom_gb, budgetGB * 0.08) * rt.headroom;
  return { weightsGB, kvCacheGB, overheadGB, neededGB, headroomGB, budgetGB, pool, ratio: neededGB / budgetGB };
}

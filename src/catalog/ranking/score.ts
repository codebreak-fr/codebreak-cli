import type { Config } from '../../config/schema.js';
import { CATEGORY_BY_ID } from '../categories.js';
import type { CatalogModel, CategoryId, Fit, Scores } from '../types.js';
import { ageMonths } from './policy.js';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Statistiques du lot de candidats, pour normaliser la popularité. */
export interface PoolStats {
  maxDownloads: number;
  maxLikes: number;
  /** plus grand modèle (en paramètres effectifs) parmi les candidats qui passent tous les filtres */
  maxParamsB: number;
}

/** Paramètres du modèle ; à défaut, déduits de la taille (~0,6 Go/B en Q4). */
const paramsOf = (m: CatalogModel) => m.paramsB ?? (m.sizeGB ?? 0) / 0.6;

export const poolStats = (models: CatalogModel[]): PoolStats => ({
  maxDownloads: Math.max(1, ...models.map((m) => m.downloads ?? 0)),
  maxLikes: Math.max(1, ...models.map((m) => m.likes ?? 0)),
  maxParamsB: Math.max(0.1, ...models.map(paramsOf)),
});

/** Une quantification agressive dégrade la qualité : Q3 ≈ -10 %, Q4 ≈ -5 %, ≥ 8 bits sans perte notable. */
export function quantFactor(label: string | undefined): number {
  const bits = Number(/(\d+)/.exec(label ?? '')?.[1]);
  if (!label || !Number.isFinite(bits)) return 0.95; // défaut des registres : Q4
  return bits >= 8 ? 1 : bits >= 5 ? 0.98 : bits === 4 ? 0.95 : 0.9;
}

const logNorm = (v: number | undefined, max: number) => (v ? clamp01(Math.log10(1 + v) / Math.log10(1 + max)) : 0);

/** Fraîcheur : 1 pour un modèle du mois, ~0,5 à 6 mois, ~0,25 à un an ; 0,25 si aucune date. */
export function recencyScore(model: CatalogModel, now: number): number {
  const age = ageMonths(model, now);
  return age === undefined ? 0.25 : clamp01(Math.exp(-Math.max(0, age) / 8.7));
}

/**
 * Qualité (proxy — les catalogues ne publient pas de benchmarks) : popularité (téléchargements, likes) et capacité
 * (un modèle plus gros, s'il tient confortablement, est en moyenne meilleur). Pour STT/TTS/embeddings/reranking,
 * la taille compte moins que l'adoption.
 */
export function qualityScore(model: CatalogModel, category: CategoryId, stats: PoolStats): number {
  const pop = logNorm(model.downloads, stats.maxDownloads);
  const likes = logNorm(model.likes, stats.maxLikes);
  const capacity = clamp01((Math.log(1 + paramsOf(model)) / Math.log(1 + stats.maxParamsB)) * quantFactor(model.quantization));
  const isLlm = CATEGORY_BY_ID[category].kind === 'llm';
  return isLlm ? 0.35 * pop + 0.1 * likes + 0.55 * capacity : 0.7 * pop + 0.15 * likes + 0.15 * capacity;
}

export function scoreModel(model: CatalogModel, category: CategoryId, fit: Fit, stats: PoolStats, routable: boolean, now: number): Scores {
  const recency = recencyScore(model, now);
  const quality = qualityScore(model, category, stats);
  const tier = fit.verdict === 'recommended' ? 1 : fit.verdict === 'alternative' ? 0.85 : 0.5;
  const compatibility = tier * (routable ? 1 : 0.85);
  const tps = fit.performance?.value;
  const performance = tps === undefined ? 0.5 : clamp01(tps / 25);
  const total = 0.45 * quality + 0.2 * recency + 0.15 * performance + 0.2 * compatibility;
  return { recency, quality, compatibility, performance, total };
}

export type ScoreConfig = Pick<Config, 'discovery'>;

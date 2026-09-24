import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import { CATEGORIES, CATEGORY_BY_ID } from './categories.js';
import { evaluateFit } from './compatibility/evaluator.js';
import { isInstalled } from './installed.js';
import { fmtGB } from './present.js';
import { selectDiverse } from './ranking/diversity.js';
import { gate, isRoutable } from './ranking/policy.js';
import { poolStats, scoreModel } from './ranking/score.js';
import type { CatalogModel, CategoryId, CategoryResult, ExcludeReason, Fit, Recommendation } from './types.js';
import { num, t } from '../i18n/index.js';

const fmtN = (n: number, d = 1) => num(n, d).replace(/[.,]0+$/, '');

function explain(model: CatalogModel, fit: Fit, rec: Pick<Recommendation, 'verdict' | 'scores' | 'routable'>): { why: string[]; warnings: string[] } {
  const why: string[] = [];
  const warnings: string[] = [];
  const m = fit.memory;
  if (rec.verdict === 'slow') {
    why.push(t('Devrait tourner sur cette machine'));
    if (m.ratio > 0.78) warnings.push(t('Marge mémoire limitée'));
    if (fit.performance?.value !== undefined) warnings.push(t('Débit plus faible (~{v} {unit})', { v: Math.round(fit.performance.value), unit: fit.performance.unit }));
    warnings.push(t('Proposé seulement comme alternative plus lente'));
  } else {
    why.push(rec.verdict === 'recommended' ? t('Tient confortablement en mémoire ({v} sur {v2})', { v: fmtGB(m.neededGB), v2: fmtGB(m.budgetGB) }) : t('Tient en mémoire avec une marge réduite ({v} sur {v2})', { v: fmtGB(m.neededGB), v2: fmtGB(m.budgetGB) }));
  }
  if (rec.scores.recency >= 0.5) why.push(t('Modèle récent'));
  if (fit.performance?.value !== undefined && rec.verdict !== 'slow') why.push(t('Bon débit estimé (~{v} {unit})', { v: Math.round(fit.performance.value), unit: fit.performance.unit }));
  if (fit.performance?.value === undefined && (model.categories.some((c) => CATEGORY_BY_ID[c].kind === 'llm'))) warnings.push(t('Débit inconnu (bande passante mémoire non détectée)'));
  if (model.capabilities.includes('tools')) why.push(t('Supporte les outils (function calling)'));
  if (model.capabilities.includes('vision')) why.push(t('Comprend les images'));
  why.push(t('Disponible via {v}', { v: model.runtime === 'ollama' ? 'Ollama' : model.runtime === 'mlx' ? 'MLX' : 'Hugging Face' }));
  if (rec.routable) why.push(t('Utilisable par le routeur CodeBreak'));
  else warnings.push(t('Non piloté par le routeur CodeBreak (téléchargement seulement)'));
  return { why, warnings };
}

function signalsOf(model: CatalogModel): string[] {
  const s: string[] = [];
  const short = (n: number) => (n >= 1e6 ? `${fmtN(n / 1e6)} M` : n >= 1e3 ? `${fmtN(n / 1e3)} k` : String(n));
  if (model.downloads) s.push(`${short(model.downloads)} ${model.source === 'ollama' ? 'pulls' : t('téléchargements')}`);
  if (model.likes) s.push(`${short(model.likes)} likes`);
  if (model.paramsB) s.push(t('{v}B paramètres{v2}', { v: fmtN(model.paramsB), v2: model.activeParamsB ? t(' ({v}B actifs)', { v: fmtN(model.activeParamsB) }) : '' }));
  if (model.contextLength) s.push(t('contexte {v}', { v: short(model.contextLength) }));
  return s;
}

/** Recommandations pour une catégorie : gates → compatibilité → scores → diversité. */
export function recommendCategory(models: CatalogModel[], category: CategoryId, det: Detection, cfg: Config, now = Date.now(), hfRoot?: string): CategoryResult {
  const excludedReasons: Partial<Record<ExcludeReason, number>> = {};
  const exclude = (r: ExcludeReason) => void (excludedReasons[r] = (excludedReasons[r] ?? 0) + 1);

  const eligible: { model: CatalogModel; fit: Fit }[] = [];
  for (const model of models.filter((m) => m.categories.includes(category))) {
    const blocked = gate(model, det, cfg, now);
    if (blocked) {
      exclude(blocked);
      continue;
    }
    const fit = evaluateFit(model, category, det.hardware, cfg);
    if (fit.verdict === 'excluded') {
      exclude(fit.reason ?? 'too-heavy');
      continue;
    }
    eligible.push({ model, fit });
  }

  const stats = poolStats(eligible.map((e) => e.model));
  const recs: Recommendation[] = eligible.map(({ model, fit }) => {
    const routable = isRoutable(model);
    const scores = scoreModel(model, category, fit, stats, routable, now);
    const verdict = fit.verdict as Recommendation['verdict'];
    const { why, warnings } = explain(model, fit, { verdict, scores, routable });
    return { model, verdict, fit, scores, routable, installed: isInstalled(model, det, hfRoot), why, warnings, signals: signalsOf(model) };
  });

  const { recommended, slow } = selectDiverse(recs);
  const excludedCount = Object.values(excludedReasons).reduce((a, b) => a + b, 0) + (recs.length - recommended.length - (slow ? 1 : 0));
  return { category, recommended, slow, excludedCount, excludedReasons };
}

export function recommendAll(models: CatalogModel[], det: Detection, cfg: Config, now = Date.now()): CategoryResult[] {
  return CATEGORIES.map((c) => recommendCategory(models, c.id, det, cfg, now));
}

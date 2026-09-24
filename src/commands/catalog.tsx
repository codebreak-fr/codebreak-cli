import type { ReactNode } from 'react';
import { afterRemoveWrites } from '../catalog/actions.js';
import { CATEGORIES, isCategoryId } from '../catalog/categories.js';
import { evaluateFit } from '../catalog/compatibility/evaluator.js';
import { categoryJson, hardwareJson } from '../catalog/json.js';
import { listInstalled, planInstall, planRemove, runInstall, runRemove } from '../catalog/installer.js';
import { fmtGB } from '../catalog/present.js';
import { loadCatalog, forgetInstalled, recordInstalled, recommendCategory } from '../catalog/index.js';
import type { Config } from '../config/schema.js';
import { setConfigValue } from '../config/load.js';
import type { Detection } from '../detect/types.js';
import { RecommendationsView } from '../ui/discovery/RecommendationsView.js';
import { t } from '../i18n/index.js';

export interface CatalogCtx {
  cfg: Config;
  det: Detection;
  json: boolean;
  refresh: boolean;
  yes: boolean;
  print: (node: ReactNode) => void;
}

export const CATALOG_ACTIONS = ['recommend', 'installed', 'install', 'remove'] as const;

const progress = (msg: string) => void (process.stderr.isTTY && process.stderr.write(`\r\x1b[2m${t('Catalogue… {msg}', { msg })}\x1b[0m\x1b[K`));
const clearProgress = () => void (process.stderr.isTTY && process.stderr.write('\r\x1b[K'));

async function catalogOf(ctx: CatalogCtx) {
  const cat = await loadCatalog(ctx.cfg, ctx.det.hardware, { refresh: ctx.refresh, onProgress: progress });
  clearProgress();
  for (const e of cat.errors) process.stderr.write(`⚠ ${e.source} : ${e.message}${cat.stale ? t(' (cache utilisé)') : ''}\n`);
  return cat;
}

/** `cb models recommend|installed|install|remove …` */
export async function catalogCommand(action: (typeof CATALOG_ACTIONS)[number], rest: string[], ctx: CatalogCtx): Promise<void> {
  const { cfg, det, json } = ctx;
  switch (action) {
    case 'recommend': {
      const [only] = rest;
      if (only && !isCategoryId(only)) throw new Error(t('Catégorie inconnue : {only}. Essaie {v}.', { only, v: CATEGORIES.map((c) => c.id).join(', ') }));
      const cat = await catalogOf(ctx);
      const ids = only && isCategoryId(only) ? [only] : CATEGORIES.map((c) => c.id);
      const results = ids.map((id) => recommendCategory(cat.models, id, det, cfg));
      if (json) {
        const hardware = hardwareJson(det, cfg);
        return console.log(JSON.stringify(only ? { hardware, ...categoryJson(results[0]!) } : { hardware, categories: results.map(categoryJson) }, null, 2));
      }
      return ctx.print(<RecommendationsView det={det} cfg={cfg} results={results} />);
    }

    case 'installed': {
      const items = listInstalled(det);
      if (json) return console.log(JSON.stringify(items, null, 2));
      return console.log(items.length ? items.map((m) => `${m.name.padEnd(56)} ${m.store.padEnd(15)} ${fmtGB(m.sizeGB)}${m.category ? `  ${m.category}` : ''}`).join('\n') : t('Aucun modèle installé.'));
    }

    case 'install': {
      const name = rest.join(' ');
      if (!name) throw new Error(t('Usage : codebreak models install <nom> [--yes]'));
      const cat = await catalogOf(ctx);
      const model = cat.models.find((m) => m.name === name || m.id === name);
      if (!model) throw new Error(t('Modèle introuvable dans le catalogue : {name}. Voir codebreak models recommend.', { name }));
      const plan = planInstall(model, det);
      if (!plan.ok) throw new Error(plan.error);
      console.log(`${plan.display}${plan.sizeGB ? ` (${fmtGB(plan.sizeGB)})` : ''}`);
      if (!ctx.yes) return console.log(t('Ajoute --yes pour lancer l’installation.'));
      const res = await runInstall(plan, { onProgress: (p, line) => process.stderr.write(`\r\x1b[K${p !== undefined ? `${p} % ` : ''}${line}`) });
      clearProgress();
      if (!res.ok) throw new Error(res.message);
      const fit = evaluateFit(model, model.categories[0]!, det.hardware, cfg);
      recordInstalled({ id: model.id, name: model.name, runtime: model.runtime, provider: model.provider, categories: model.categories, hardwareFit: fit.verdict, tokensPerSecond: fit.performance?.value, installedAt: Date.now() });
      return console.log(t('Installé : {name}', { name: model.name }));
    }

    case 'remove': {
      const name = rest.join(' ');
      if (!name) throw new Error(t('Usage : codebreak models remove <nom> [--yes]'));
      const target = listInstalled(det).find((m) => m.name === name);
      if (!target) throw new Error(t('Modèle non installé : {name}. Voir codebreak models installed.', { name }));
      const plan = planRemove(target, det);
      if (!plan.ok) throw new Error(plan.error);
      console.log(`${plan.display}${plan.freedGB ? t(' (libère {v})', { v: fmtGB(plan.freedGB) }) : ''}`);
      if (!ctx.yes) return console.log(t('Suppression irréversible. Ajoute --yes pour confirmer.'));
      const res = await runRemove(plan);
      if (!res.ok) throw new Error(res.message);
      forgetInstalled(`${target.runtime}:${target.name}`);
      for (const [key, val] of afterRemoveWrites(target, cfg)) setConfigValue(key, val);
      return console.log(t('Supprimé : {name}', { name: target.name }));
    }
  }
}

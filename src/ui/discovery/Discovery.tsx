import { Text, useInput } from 'ink';
import { useMemo, useRef, useState } from 'react';
import { CATEGORY_BY_ID, categoryDescription, categoryLabel } from '../../catalog/categories.js';
import { listInstalled, planInstall, planRemove, type InstalledModel, type ModelRef, type RemoveRef } from '../../catalog/installer.js';
import { forgetInstalled, recordInstalled } from '../../catalog/registry.js';
import { recommendAll } from '../../catalog/recommendations.js';
import type { CategoryId, CategoryResult, Recommendation } from '../../catalog/types.js';
import type { Config } from '../../config/schema.js';
import type { Detection } from '../../detect/types.js';
import { SelectList, Panel, type Hint } from '../kit/index.js';
import { Spinner } from '../Spinner.js';
import { color } from '../theme.js';
import { ActionConfirm } from './ActionConfirm.js';
import { CategoryList, type CategoryChoice } from './CategoryList.js';
import { HardwareView } from './HardwareView.js';
import { InstalledList } from './InstalledList.js';
import { ModelDetails, type DetailAction } from './ModelDetails.js';
import { ModelList } from './ModelList.js';
import { RunView } from './RunView.js';
import { useCatalog } from './useCatalog.js';
import { WhyFits } from './WhyFits.js';
import { num, t } from '../../i18n/index.js';

export interface DiscoveryProps {
  det: Detection;
  cfg: Config;
  initialCategory?: CategoryId;
  onClose: () => void;
  /** relance la détection (`cb detect` fait foi pour les modèles installés) */
  onDetect: () => Promise<Detection>;
  onUse: (m: ModelRef) => void;
  onRemoved: (m: RemoveRef) => void;
  onNotice: (text: string, level?: 'info' | 'error') => void;
}

type Op = 'install' | 'remove';
type Screen =
  | { name: 'categories'; focus?: CategoryChoice }
  | { name: 'models'; category: CategoryId; index: number }
  | { name: 'details'; category: CategoryId; modelId: string; rec: Recommendation }
  | { name: 'why'; category: CategoryId; modelId: string; rec: Recommendation }
  | { name: 'installed' }
  | { name: 'confirm'; op: Op; ref: RemoveRef; rec?: Recommendation }
  | { name: 'run'; op: Op; ref: RemoveRef; rec?: Recommendation }
  | { name: 'result'; op: Op; ref: RemoveRef; rec?: Recommendation; ok: boolean; message: string };

const ago = (ms: number) => {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 1 ? t('à l’instant') : min < 60 ? t('il y a {min} min', { min }) : min < 2880 ? t('il y a {v} h', { v: Math.round(min / 60) }) : t('il y a {v} j', { v: Math.round(min / 1440) });
};

const HINTS = {
  categories: [['↑↓', 'naviguer'], ['Entrée', 'choisir'], ['r', 'rafraîchir'], ['Esc', 'fermer']],
  models: [['↑↓', 'naviguer'], ['Entrée', 'détails'], ['i', 'installer'], ['Esc', 'retour']],
  details: [['↑↓', 'naviguer'], ['Entrée', 'choisir'], ['Esc', 'retour']],
  why: [['Esc', 'retour']],
  installed: [['↑↓', 'naviguer'], ['Entrée', 'supprimer'], ['Esc', 'retour']],
  confirm: [['↑↓', 'naviguer'], ['Entrée', 'valider'], ['Esc', 'annuler']],
  run: [['Esc', 'interrompre']],
  result: [['↑↓', 'naviguer'], ['Entrée', 'choisir'], ['Esc', 'retour']],
} satisfies Record<string, readonly Hint[]>;

/** Discovery : machine → catégorie → modèles adaptés → fiche → installation / suppression. Toute la logique est dans `src/catalog`. */
export function Discovery({ det, cfg, initialCategory, onClose, onDetect, onUse, onRemoved, onNotice }: DiscoveryProps) {
  const [state, refresh] = useCatalog(cfg, det.hardware);
  const [stack, setStack] = useState<Screen[]>(() => [{ name: 'categories' }, ...(initialCategory ? [{ name: 'models', category: initialCategory, index: 0 } as Screen] : [])]);
  const abort = useRef<AbortController | null>(null);
  const screen = stack.at(-1)!;

  const push = (s: Screen) => setStack((st) => [...st, s]);
  const replace = (s: Screen) => setStack((st) => [...st.slice(0, -1), s]);
  const pop = () => (stack.length > 1 ? setStack((st) => st.slice(0, -1)) : onClose());
  /** revient à la dernière fiche/liste (au-delà des écrans de confirmation, progression et résultat) */
  const backToBrowse = () =>
    setStack((st) => {
      const browse = st.filter((s) => s.name !== 'confirm' && s.name !== 'run' && s.name !== 'result');
      return browse.length ? browse : [{ name: 'categories' }];
    });

  const results = useMemo(() => {
    if (state.status !== 'ready') return null;
    return Object.fromEntries(recommendAll(state.catalog.models, det, cfg).map((r) => [r.category, r])) as Record<CategoryId, CategoryResult>;
  }, [state, det, cfg]);
  const installed = useMemo(() => listInstalled(det).sort((a, b) => b.sizeGB - a.sizeGB), [det]);
  const installedByCategory = useMemo(() => {
    const out: Partial<Record<CategoryId, number>> = {};
    for (const m of installed) if (m.category) out[m.category] = (out[m.category] ?? 0) + 1;
    return out;
  }, [installed]);

  const recFor = (category: CategoryId, modelId: string, fallback: Recommendation) => {
    const r = results?.[category];
    return [...(r?.recommended ?? []), ...(r?.slow ? [r.slow] : [])].find((x) => x.model.id === modelId) ?? fallback;
  };

  useInput((input, key) => {
    if (screen.name === 'run') {
      if (key.escape || (key.ctrl && input === 'c')) abort.current?.abort();
      return;
    }
    if (key.ctrl && input === 'c') return onClose();
    if (key.escape) pop();
  });

  const ask = (op: Op, ref: RemoveRef, rec?: Recommendation) => {
    const plan = op === 'install' ? planInstall(ref, det) : planRemove(ref, det);
    if (!plan.ok) return onNotice(plan.error, 'error');
    push({ name: 'confirm', op, ref, rec });
  };

  const finish = async (s: Extract<Screen, { name: 'run' }>, ok: boolean, message: string) => {
    if (ok) {
      if (s.op === 'install' && s.rec) {
        recordInstalled({ id: s.rec.model.id, name: s.ref.name, runtime: s.rec.model.runtime, provider: s.rec.model.provider, categories: s.rec.model.categories, hardwareFit: s.rec.verdict, tokensPerSecond: s.rec.fit.performance?.value, installedAt: Date.now() });
      } else if (s.op === 'remove') {
        forgetInstalled(s.rec?.model.id ?? `${s.ref.runtime}:${s.ref.name}`);
        onRemoved(s.ref);
      }
      await onDetect();
    }
    if (ok) onNotice(`${s.op === 'install' ? t('Modèle installé') : t('Modèle supprimé')} : ${s.ref.name}`);
    replace({ name: 'result', op: s.op, ref: s.ref, rec: s.rec, ok, message });
  };

  // --- rendu ---
  if (state.status === 'loading' || !results) {
    return (
      <Panel title={t('Découvrir l’IA locale')} hints={[['Esc', 'fermer']]}>
        <HardwareView det={det} cfg={cfg} />
        <Text> </Text>
        <Spinner label={t('Lecture du catalogue{v}', { v: state.status === 'loading' && state.progress ? ` (${state.progress})` : '' })} startedAt={state.status === 'loading' ? state.startedAt : Date.now()} />
      </Panel>
    );
  }
  const { catalog } = state;
  const catLabel = (id: CategoryId) => `${CATEGORY_BY_ID[id].icon} ${categoryLabel(id)}`;

  switch (screen.name) {
    case 'categories':
      return (
        <Panel
          title={t('Découvrir l’IA locale')}
          subtitle={
            <>
              {t('Catalogue mis à jour ')}{ago(catalog.fetchedAt)} · {catalog.models.length} {t('modèles')}{catalog.errors.length ? <Text color={color.warn}> {t('· ⚠ hors ligne : ')}{catalog.errors.map((e) => e.source).join(', ')}{catalog.stale ? ' (cache)' : ''}</Text> : null}
            </>
          }
          hints={HINTS.categories}
        >
          <HardwareView det={det} cfg={cfg} />
          <Text> </Text>
          <CategoryList
            results={results}
            installed={installedByCategory}
            installedCount={installed.length}
            initial={screen.focus}
            onRefresh={refresh}
            onSelect={(c) => {
              setStack((st) => [...st.slice(0, -1), { name: 'categories', focus: c }]);
              push(c === 'installed' ? { name: 'installed' } : { name: 'models', category: c, index: 0 });
            }}
          />
        </Panel>
      );

    case 'models': {
      const result = results[screen.category];
      const recs = [...result.recommended, ...(result.slow ? [result.slow] : [])];
      return (
        <Panel title={`← ${catLabel(screen.category)}`} subtitle={categoryDescription(screen.category)} hints={HINTS.models}>
          <ModelList
            result={result}
            installed={installed.filter((m) => m.category === screen.category && !recs.some((r) => r.model.name === m.name))}
            initial={screen.index}
            onDetails={(rec, i) => {
              setStack((st) => [...st.slice(0, -1), { ...screen, index: i }]);
              push({ name: 'details', category: screen.category, modelId: rec.model.id, rec });
            }}
            onInstall={(rec, i) => {
              setStack((st) => [...st.slice(0, -1), { ...screen, index: i }]);
              ask('install', rec.model, rec);
            }}
          />
          {recs.length && result.excludedCount ? <Text color={color.dim}>{result.excludedCount} {t('autres modèles non retenus (trop lourds, anciens, doublons de fournisseur…)')}</Text> : null}
        </Panel>
      );
    }

    case 'details': {
      const rec = recFor(screen.category, screen.modelId, screen.rec);
      return (
        <Panel title={`${rec.model.name}`} subtitle={catLabel(screen.category)} hints={HINTS.details}>
          <ModelDetails
            rec={rec}
            onAction={(a: DetailAction) => {
              if (a === 'back') pop();
              else if (a === 'why') push({ name: 'why', category: screen.category, modelId: rec.model.id, rec });
              else if (a === 'use') onUse(rec.model);
              else ask(a === 'install' ? 'install' : 'remove', rec.model, rec);
            }}
          />
        </Panel>
      );
    }

    case 'why': {
      const rec = recFor(screen.category, screen.modelId, screen.rec);
      return (
        <Panel title={t('Pourquoi ça tient ?')} subtitle={rec.model.name} hints={HINTS.why}>
          <WhyFits rec={rec} det={det} cfg={cfg} />
        </Panel>
      );
    }

    case 'installed':
      return (
        <Panel title={t('📦 Modèles installés')} subtitle={t('{length} modèle{v} · {v2} Go', { length: installed.length, v: installed.length > 1 ? 's' : '', v2: num(installed.reduce((a, m) => a + m.sizeGB, 0), 1) })} hints={HINTS.installed}>
          <InstalledList items={installed} onRemove={(m: InstalledModel) => ask('remove', m)} />
        </Panel>
      );

    case 'confirm': {
      const plan = screen.op === 'install' ? planInstall(screen.ref, det) : planRemove(screen.ref, det);
      if (!plan.ok) return <Panel title={t('Impossible')} hints={HINTS.why}><Text color={color.err}>{plan.error}</Text></Panel>;
      return (
        <Panel title={`${screen.op === 'install' ? t('Installer') : t('Supprimer')} ${screen.ref.name}`} hints={HINTS.confirm}>
          <ActionConfirm
            op={screen.op}
            plan={plan}
            rec={screen.rec}
            onChoose={(yes) => {
              if (!yes) return pop();
              abort.current = new AbortController();
              replace({ name: 'run', op: screen.op, ref: screen.ref, rec: screen.rec });
            }}
          />
        </Panel>
      );
    }

    case 'run': {
      const plan = screen.op === 'install' ? planInstall(screen.ref, det) : planRemove(screen.ref, det);
      if (!plan.ok) return <Panel title={t('Impossible')} hints={HINTS.why}><Text color={color.err}>{plan.error}</Text></Panel>;
      return (
        <Panel title={`${screen.op === 'install' ? 'Installation' : t('Suppression')} — ${screen.ref.name}`} hints={HINTS.run}>
          <RunView op={screen.op} plan={plan} abort={abort.current ?? new AbortController()} onDone={(r) => void finish(screen, r.ok, r.message)} />
        </Panel>
      );
    }

    case 'result': {
      const usable = screen.ok && screen.op === 'install' && (screen.rec?.routable ?? screen.ref.runtime === 'ollama');
      return (
        <Panel title={screen.ok ? (screen.op === 'install' ? t('✔ Installé') : t('✔ Supprimé')) : t('✘ Échec')} subtitle={screen.ref.name} borderColor={screen.ok ? color.brand : color.err} hints={HINTS.result}>
          <Text color={screen.ok ? color.ok : color.err}>
            {screen.ok ? (screen.op === 'install' ? (usable ? t('Ce modèle est maintenant disponible pour CodeBreak.') : t('Modèle téléchargé (ce runtime n’est pas encore piloté par le routeur).')) : t('Modèle supprimé.')) : screen.message}
          </Text>
          <Text> </Text>
          <SelectList
            items={[
              ...(usable ? [{ label: t('Utiliser ce modèle'), hint: t('défaut local du routeur'), value: 'use' as const }] : []),
              { label: t('Retour à Discovery'), value: 'back' as const },
            ]}
            onSelect={(v) => {
              if (v === 'use' && screen.ref.runtime !== 'app') onUse({ runtime: screen.ref.runtime, name: screen.ref.name });
              backToBrowse();
            }}
          />
        </Panel>
      );
    }
  }
}

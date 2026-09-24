import { Box, Text, useInput } from 'ink';
import { fmtGB, fmtParams, fmtPerf, RUNTIME_LABEL, summarizeModel, VERDICT_ICON, verdictLabel } from '../../catalog/present.js';
import type { InstalledModel } from '../../catalog/installer.js';
import type { CategoryResult, Recommendation } from '../../catalog/types.js';
import { Field, ListRow, useListNav } from '../kit/index.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

const verdictColor = { recommended: color.ok, alternative: color.warn, slow: color.dim } as const;

/** Recommandations d'une catégorie : la ligne sélectionnée est détaillée, les autres restent compactes. */
export function ModelList({
  result,
  installed = [],
  initial = 0,
  onDetails,
  onInstall,
}: {
  result: CategoryResult;
  /** modèles déjà présents sur la machine pour cette catégorie (hors recommandations) */
  installed?: InstalledModel[];
  initial?: number;
  onDetails: (r: Recommendation, index: number) => void;
  onInstall: (r: Recommendation, index: number) => void;
}) {
  const recs = [...result.recommended, ...(result.slow ? [result.slow] : [])];
  const [sel] = useListNav(recs.length, initial);
  useInput((input, key) => {
    const r = recs[sel];
    if (!r) return;
    if (key.return || input === 'd') onDetails(r, sel);
    else if (input === 'i' && !r.installed) onInstall(r, sel);
  });

  const already = installed.length ? (
    <Box flexDirection="column" marginTop={recs.length ? 1 : 0}>
      <Text bold>{t('Déjà installés sur cette machine')}</Text>
      {installed.map((m) => (
        <Text key={`${m.store}:${m.name}`} color={color.dim} wrap="truncate-end">
          {'  '}<Text color={color.ok}>✔</Text> {m.name} · {m.store} · {fmtGB(m.sizeGB)}
        </Text>
      ))}
    </Box>
  ) : null;

  if (!recs.length) {
    return (
      <>
        <Text color={color.warn}>{t('Aucun modèle de cette catégorie ne convient à cette machine.')}</Text>
        <Text color={color.dim}>{describeExcluded(result)}</Text>
        {already}
      </>
    );
  }
  return (
    <>
      {recs.map((r, i) => {
        const selected = i === sel;
        return (
          <Box key={r.model.id} flexDirection="column" marginTop={i === result.recommended.length && r.verdict === 'slow' ? 1 : 0}>
            <ListRow selected={selected}>
              {VERDICT_ICON[r.verdict]} {r.model.name}
              {r.installed ? <Text color={color.ok}> {t('✔ installé')}</Text> : null}
            </ListRow>
            {selected ? (
              <Box flexDirection="column" paddingLeft={5}>
                <Field label={t('Fournisseur')} width={13}>{r.model.provider}</Field>
                <Field label={t('Taille')} width={13}>{`${fmtParams(r.model)}${r.model.quantization ? ` · ${r.model.quantization}` : ''}`}</Field>
                <Field label={t('Mémoire')} width={13}>{t('{v} sur {v2}', { v: fmtGB(r.fit.memory.neededGB), v2: fmtGB(r.fit.memory.budgetGB) })}</Field>
                <Field label={t('Vitesse')} width={13}>{fmtPerf(r)}</Field>
                <Field label="Runtime" width={13}>{RUNTIME_LABEL[r.model.runtime]}</Field>
              </Box>
            ) : (
              <Text color={color.dim} wrap="truncate-end">
                {'     '}
                <Text color={verdictColor[r.verdict as keyof typeof verdictColor]}>{verdictLabel(r.verdict)}</Text> · {summarizeModel(r)}
              </Text>
            )}
          </Box>
        );
      })}
      {already}
    </>
  );
}

export function describeExcluded(result: CategoryResult): string {
  const labels: Record<string, string> = {
    'too-heavy': t('trop lourds'),
    'too-slow': t('trop lents'),
    'unknown-size': t('taille inconnue'),
    'runtime-missing': t('runtime absent'),
    stale: t('trop anciens'),
    'low-signal': t('peu adoptés'),
    'wrong-hardware': t('matériel inadapté'),
  };
  const parts = Object.entries(result.excludedReasons).map(([k, n]) => `${n} ${labels[k] ?? k}`);
  return parts.length ? t('Écartés : {v}.', { v: parts.join(', ') }) : t('Rien dans le catalogue pour cette catégorie.');
}

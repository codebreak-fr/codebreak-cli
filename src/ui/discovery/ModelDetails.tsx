import { Box, Text } from 'ink';
import { fmtDate, fmtGB, fmtParams, fmtPerf, RUNTIME_LABEL, VERDICT_ICON, verdictLabel } from '../../catalog/present.js';
import type { Recommendation } from '../../catalog/types.js';
import { categoryLabel } from '../../catalog/categories.js';
import { Field, SelectList, type ListItem } from '../kit/index.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

export type DetailAction = 'install' | 'why' | 'use' | 'remove' | 'back';

/** Fiche complète d'un modèle + actions (installer, comprendre l'adéquation, utiliser, supprimer). */
export function ModelDetails({ rec, onAction }: { rec: Recommendation; onAction: (a: DetailAction) => void }) {
  const m = rec.model;
  const items: ListItem<DetailAction>[] = [
    ...(rec.installed ? [] : [{ label: t('Installer'), value: 'install' as const }]),
    ...(rec.installed && rec.routable ? [{ label: t('Utiliser ce modèle'), hint: t('défaut local du routeur'), value: 'use' as const }] : []),
    { label: t('Pourquoi ça tient sur ma machine ?'), value: 'why' },
    ...(rec.installed ? [{ label: t('Supprimer'), value: 'remove' as const }] : []),
    { label: t('Retour'), value: 'back' },
  ];
  const w = 16;
  return (
    <>
      <Field label="Verdict" width={w}>
        <Text>
          {VERDICT_ICON[rec.verdict]} {verdictLabel(rec.verdict)}
          {rec.installed ? <Text color={color.ok}> {t('· ✔ installé')}</Text> : null}
        </Text>
      </Field>
      <Field label={t('Fournisseur')} width={w}>{`${m.provider}${m.publisher !== 'ollama' && m.publisher.toLowerCase() !== m.provider.toLowerCase() ? t(' (publié par {publisher})', { publisher: m.publisher }) : ''}`}</Field>
      <Field label={t('Catégories')} width={w}>{m.categories.map((c) => categoryLabel(c)).join(', ')}</Field>
      <Field label={t('Sortie')} width={w}>{fmtDate(m.releaseDate ?? m.lastUpdated)}{!m.releaseDate && m.lastUpdated ? t(' (dernière mise à jour)') : ''}</Field>
      <Field label={t('Paramètres')} width={w}>{fmtParams(m)}</Field>
      <Field label={t('Quantification')} width={w}>{m.quantization ?? 'inconnue'}</Field>
      <Field label={t('Contexte')} width={w}>{m.contextLength ? `${Math.round(m.contextLength / 1024)}k tokens` : 'inconnu'}</Field>
      <Field label="Runtime" width={w}>{RUNTIME_LABEL[m.runtime]}</Field>
      <Field label={t('Mémoire')} width={w}>{t('{v} (poids {v2})', { v: fmtGB(rec.fit.memory.neededGB), v2: fmtGB(rec.fit.memory.weightsGB) })}</Field>
      <Field label="Performance" width={w}>{fmtPerf(rec)}</Field>
      <Field label={t('Signaux')} width={w}>{rec.signals.join(' · ') || 'inconnus'}</Field>
      <Field label="Source" width={w}>{m.sourceUrl}</Field>
      <Field label="Installation" width={w}>{m.installCommand}</Field>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{rec.verdict === 'slow' ? t('🐢 Alternative plus lente') : t('Pourquoi recommandé ?')}</Text>
        {rec.why.map((w2) => (
          <Text key={w2} color={color.ok} wrap="truncate-end">✓ {w2}</Text>
        ))}
        {rec.warnings.map((w2) => (
          <Text key={w2} color={color.warn} wrap="truncate-end">⚠ {w2}</Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <SelectList items={items} onSelect={onAction} />
      </Box>
    </>
  );
}

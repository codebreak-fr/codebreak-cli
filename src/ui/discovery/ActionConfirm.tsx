import { Box, Text } from 'ink';
import { fmtGB, RUNTIME_LABEL } from '../../catalog/present.js';
import type { Plan, RemovePlan } from '../../catalog/installer.js';
import type { Recommendation } from '../../catalog/types.js';
import { Field, SelectList } from '../kit/index.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

type OkPlan = Extract<Plan, { ok: true }> | Extract<RemovePlan, { ok: true }>;

/** Confirmation avant installation ou suppression : ce qui va être exécuté, puis Confirmer / Annuler. */
export function ActionConfirm({
  op,
  plan,
  rec,
  onChoose,
}: {
  op: 'install' | 'remove';
  plan: OkPlan;
  rec?: Recommendation;
  onChoose: (confirm: boolean) => void;
}) {
  const w = 17;
  const size = op === 'install' ? (plan as Extract<Plan, { ok: true }>).sizeGB : (plan as Extract<RemovePlan, { ok: true }>).freedGB;
  return (
    <>
      <Field label="Runtime" width={w}>{RUNTIME_LABEL[plan.runtime]}</Field>
      <Field label={op === 'install' ? t('Taille') : t('Espace libéré')} width={w}>{fmtGB(size)}</Field>
      {op === 'install' && rec ? <Field label={t('Mémoire estimée')} width={w}>{fmtGB(rec.fit.memory.neededGB)}</Field> : null}
      <Field label={op === 'install' ? t('Commande') : 'Action'} width={w}>{plan.display}</Field>
      {op === 'remove' ? (
        <Box marginTop={1}>
          <Text color={color.warn}>{t('Irréversible : le modèle devra être retéléchargé pour être réutilisé.')}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <SelectList
          items={[
            { label: op === 'install' ? t('Confirmer l’installation') : t('Confirmer la suppression'), value: true },
            { label: t('Annuler'), value: false },
          ]}
          initial={op === 'remove' ? 1 : 0}
          onSelect={onChoose}
        />
      </Box>
    </>
  );
}

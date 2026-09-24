import { Box, Text } from 'ink';
import type { Config } from '../../config/schema.js';
import type { Detection } from '../../detect/types.js';
import { describeMachine, fmtGB, fmtParams, VERDICT_ICON, verdictLabel } from '../../catalog/present.js';
import type { Recommendation } from '../../catalog/types.js';
import { Field } from '../kit/index.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

const POOL = { vram: 'VRAM', unified: 'mémoire unifiée', ram: 'RAM' } as const;

/** Vue pédagogique : de quoi est faite la mémoire nécessaire, et pourquoi elle tient (ou non) avec une marge. */
export function WhyFits({ rec, det, cfg }: { rec: Recommendation; det: Detection; cfg: Config }) {
  const { memory: m } = rec.fit;
  const machine = describeMachine(det.hardware, cfg);
  const w = 20;
  const left = m.budgetGB - m.neededGB - m.headroomGB;
  return (
    <>
      <Text bold>{t('Votre machine')}</Text>
      <Field label={machine.title} width={w}>{machine.memory}</Field>
      <Field label={t('Utilisable ({v})', { v: t(POOL[m.pool]) })} width={w}>{fmtGB(m.budgetGB)}</Field>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{t('Le modèle')}</Text>
        <Field label={t('Paramètres')} width={w}>{`${fmtParams(rec.model)}${rec.model.quantization ? ` · ${rec.model.quantization}` : ''}`}</Field>
        <Field label={t('Poids')} width={w}>{fmtGB(m.weightsGB)}</Field>
        <Field label={t('Cache de contexte')} width={w}>{m.kvCacheGB ? `${fmtGB(m.kvCacheGB)} (KV cache, ${cfg.discovery.context_tokens} tokens)` : 'aucun'}</Field>
        <Field label={t('Surcoût runtime')} width={w}>{fmtGB(m.overheadGB)}</Field>
        <Field label={t('Besoin total')} width={w}>{fmtGB(m.neededGB)}</Field>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{t('Marge de sécurité')}</Text>
        <Field label={t('Réservée (OS, autres apps)')} width={w + 6}>{fmtGB(m.headroomGB)}</Field>
        <Field label={t('Reste après marge')} width={w + 6}>
          <Text color={left >= 0 ? color.ok : color.warn}>{left >= 0 ? fmtGB(left) : `−${fmtGB(-left)}`}</Text>
        </Field>
      </Box>
      <Box marginTop={1}>
        <Text>
          {t('Résultat : ')}{VERDICT_ICON[rec.verdict]} <Text bold>{verdictLabel(rec.verdict)}</Text>
          <Text color={color.dim}> ({Math.round(m.ratio * 100)} {t('% de la mémoire utilisable)')}</Text>
        </Text>
      </Box>
    </>
  );
}

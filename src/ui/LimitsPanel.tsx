import { Box, Text } from 'ink';
import { t } from '../i18n/index.js';
import { usageRows, type UsageRow } from '../usage/monitor.js';
import type { Confidence, MetricSource, ServiceStatus, ServiceUsage, UsageMetric } from '../usage/types.js';
import { bar, fmtReset, pct } from './format.js';
import { color } from './theme.js';

export const STATUS_LABEL: Record<ServiceStatus, string> = {
  available: 'disponible',
  limited: 'limité',
  exhausted: 'épuisé',
  auth_error: 'authentification',
  unavailable: 'indisponible',
  unknown: 'inconnu',
};
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: 'haute', medium: 'moyenne', low: 'basse' };
export const SOURCE_LABEL: Record<MetricSource, string> = { observed: 'observé', estimated: 'estimé', unknown: 'inconnu' };

const STATUS_COLOR: Record<ServiceStatus, string> = { available: color.ok, limited: color.warn, exhausted: color.err, auth_error: color.err, unavailable: color.dim, unknown: color.dim };
const CONF_COLOR: Record<Confidence, string> = { high: color.ok, medium: color.warn, low: color.dim };

const WINDOW_TAG: Record<string, string> = { window_5h: '5h', window_7d: '7j' };

/** Valeur d'usage avec sa provenance : `72%` observé · `~0%` estimé · `?` inconnu · `n/a` sans objet (local). */
export function usageCell(r: UsageRow, s: ServiceUsage): string {
  if (r.kind === 'local') return t('n/a');
  const wins = s.metrics.filter((m) => m.metric.startsWith('window_') && typeof m.value === 'number');
  if (!wins.length) return '?';
  return wins.map((m) => `${WINDOW_TAG[m.metric] ?? m.metric.replace('window_', '')} ${m.source === 'estimated' ? '~' : ''}${pct(m.value as number)}`).join(' · ');
}

const time = (ms: number | null) => (ms === null ? '?' : new Date(ms).toTimeString().slice(0, 5));
const metricValue = (m: UsageMetric) => (m.value === null ? '?' : m.unit === 'ratio' ? pct(m.value as number) : String(m.value));

/** `/usage` : état unifié des limites. `detail` liste chaque valeur avec sa source, son origine et son horodatage. */
export function LimitsPanel({ services, detail }: { services: ServiceUsage[]; detail?: boolean }) {
  const rows = usageRows(services);
  const w = { svc: 15, st: 17, use: 26, reset: 14 };
  return (
    <Box flexDirection="column">
      <Text bold>{t('Limites d’usage')}</Text>
      <Text color={color.dim}>
        {'  '}{t('Service').padEnd(w.svc)}{t('Statut').padEnd(w.st)}{t('Usage').padEnd(w.use)}{t('Reset').padEnd(w.reset)}{t('Confiance')}
      </Text>
      {rows.map((r, i) => {
        const s = services[i]!;
        const reset = r.resetAt ? fmtReset(Math.floor(r.resetAt / 1000)) : r.kind === 'local' ? '' : '?';
        const head = s.metrics.find((m) => m.metric.startsWith('window_') && typeof m.value === 'number');
        return (
          <Box key={r.service} flexDirection="column">
            <Text>
              {'  '}
              <Text bold>{r.label.padEnd(w.svc)}</Text>
              <Text color={STATUS_COLOR[r.status]}>{t(STATUS_LABEL[r.status]).padEnd(w.st)}</Text>
              <Text color={r.ratio === null ? color.dim : undefined}>{usageCell(r, s).padEnd(w.use)}</Text>
              <Text color={color.dim}>{reset.padEnd(w.reset)}</Text>
              <Text color={CONF_COLOR[r.confidence]}>{t(CONFIDENCE_LABEL[r.confidence])}</Text>
            </Text>
            {head && !detail ? (
              <Text color={color.dim}>
                {'      '}
                {s.metrics.filter((m) => m.metric.startsWith('window_') && typeof m.value === 'number').map((m) => `${WINDOW_TAG[m.metric] ?? m.metric} ${bar(m.value as number, 10)}`).join('   ')}
              </Text>
            ) : null}
            {r.note && !detail ? <Text color={color.dim} wrap="truncate-end">{'      '}{r.note}</Text> : null}
            {detail
              ? s.metrics.map((m) => (
                  <Text key={m.metric} color={color.dim} wrap="truncate-end">
                    {'      '}
                    {m.metric.padEnd(22)}
                    <Text color={m.source === 'unknown' ? color.warn : undefined}>{metricValue(m).padEnd(12)}</Text>
                    {t(SOURCE_LABEL[m.source]).padEnd(9)}{m.origin}{m.observedAt ? ` · ${time(m.observedAt)}` : ''}{m.note ? ` · ${m.note}` : ''}
                  </Text>
                ))
              : null}
          </Box>
        );
      })}
      <Text color={color.dim}>{'  '}{t('~ = estimé · ? = inconnu : une valeur non observable n’est jamais présentée comme un fait')}</Text>
    </Box>
  );
}

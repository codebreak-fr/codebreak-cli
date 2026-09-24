import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';

/**
 * Chaque valeur relative à une limite d'usage dit d'où elle vient :
 *  - observed  : lue telle quelle auprès d'une source officielle ou d'un événement réel ;
 *  - estimated : déduite (ex. fenêtre dont l'échéance est passée → 0), avec une confiance ;
 *  - unknown   : non observable de façon fiable. On n'invente jamais un chiffre.
 */
export type MetricSource = 'observed' | 'estimated' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';
export type MetricUnit = 'ratio' | 'requests' | 'tokens' | 'usd' | 'gb' | 'tokens_per_s' | 'ms' | 'text' | 'count';

export interface UsageMetric {
  service: string;
  /** ex. window_5h, window_7d, requests_remaining, tokens_today, ram_free_gb */
  metric: string;
  value: number | string | null;
  unit: MetricUnit;
  source: MetricSource;
  /** d'où vient la valeur (`claude-code:rate_limit_event`, `anthropic-api:headers`, `opencode stats`…) */
  origin: string;
  /** epoch ms de l'observation ; null si inconnue */
  observedAt: number | null;
  /** epoch ms de la prochaine remise à zéro, si connue */
  resetAt?: number;
  confidence: Confidence;
  note?: string;
}

export type ServiceStatus = 'available' | 'limited' | 'exhausted' | 'auth_error' | 'unavailable' | 'unknown';

export interface ServiceUsage {
  service: string;
  label: string;
  kind: 'cloud' | 'local';
  status: ServiceStatus;
  /** le statut lui-même est-il observé, déduit ou inconnu ? */
  statusSource: MetricSource;
  statusNote?: string;
  metrics: UsageMetric[];
}

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface UsageContext {
  cfg: Config;
  det: Detection;
  now: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  /** force une nouvelle lecture des sources (sonde) plutôt que le cache */
  refresh: boolean;
  home: string;
  /** échantillonneur de la machine (injectable pour les tests) */
  sampleMachine?: () => Promise<import('./providers/local.js').MachineSample>;
}

export interface UsageProvider {
  id: string;
  label: string;
  kind: 'cloud' | 'local';
  collect(ctx: UsageContext): Promise<ServiceUsage>;
}

export const unknownMetric = (service: string, metric: string, note: string, unit: MetricUnit = 'text'): UsageMetric => ({
  service,
  metric,
  value: null,
  unit,
  source: 'unknown',
  origin: 'none',
  observedAt: null,
  confidence: 'low',
  note,
});

/** Fraîcheur d'une observation → confiance (une valeur ancienne reste « observée » mais moins fiable). */
export function freshness(observedAt: number | null, now: number, fastMin = 15, slowMin = 120): Confidence {
  if (observedAt === null) return 'low';
  const age = (now - observedAt) / 60_000;
  return age <= fastMin ? 'high' : age <= slowMin ? 'medium' : 'low';
}

/** Métrique de fenêtre la plus contraignante d'un service (utilisation la plus haute), pour l'affichage synthétique. */
export function headlineWindow(s: ServiceUsage): UsageMetric | undefined {
  return s.metrics
    // seules les fenêtres de quota comptent (pas la charge CPU d'un service local)
    .filter((m) => m.metric.startsWith('window_') && m.unit === 'ratio' && typeof m.value === 'number')
    .sort((a, b) => (b.value as number) - (a.value as number))[0];
}

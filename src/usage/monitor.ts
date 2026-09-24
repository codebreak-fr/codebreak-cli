import { homedir } from 'node:os';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { Target } from '../types.js';
import { activeIncident, recordIncident, type Incident } from './incidents.js';
import { anthropicApiProvider, openaiApiProvider } from './providers/api.js';
import { claudeProvider } from './providers/claude.js';
import { aiderProvider, codexProvider, copilotProvider, geminiProvider, opencodeProvider, vibeProvider } from './providers/cloud.js';
import { llamacppProvider, lmsProvider, ollamaProvider } from './providers/local.js';
import { parseResetHint } from './reset.js';
import { headlineWindow, type Confidence, type FetchLike, type ServiceUsage, type UsageContext, type UsageMetric, type UsageProvider } from './types.js';

export const DEFAULT_PROVIDERS: UsageProvider[] = [
  claudeProvider,
  codexProvider,
  copilotProvider,
  geminiProvider,
  opencodeProvider,
  vibeProvider,
  aiderProvider,
  anthropicApiProvider,
  openaiApiProvider,
  ollamaProvider,
  lmsProvider,
  llamacppProvider,
];

type Applicable = UsageProvider & { applicable?: (ctx: UsageContext) => boolean; refresh?: (ctx: UsageContext) => Promise<void> };

export interface CollectOptions {
  cfg: Config;
  det: Detection;
  /** relit les sources (sonde Claude, `opencode stats`, sondes d'API) au lieu des caches */
  refresh?: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  home?: string;
  providers?: UsageProvider[];
  sampleMachine?: UsageContext['sampleMachine'];
  /** garde aussi les outils non installés */
  includeMissing?: boolean;
}

/** État unifié de tous les services (cloud et local). Ne lève jamais : un fournisseur défaillant devient `unknown`. */
export async function collectUsage(o: CollectOptions): Promise<ServiceUsage[]> {
  const ctx: UsageContext = {
    cfg: o.cfg,
    det: o.det,
    now: o.now ?? Date.now(),
    env: o.env ?? process.env,
    fetchImpl: o.fetchImpl ?? ((url, init) => fetch(url, init)),
    refresh: Boolean(o.refresh),
    home: o.home ?? homedir(),
    sampleMachine: o.sampleMachine,
  };
  const providers = ((o.providers ?? DEFAULT_PROVIDERS) as Applicable[]).filter((p) => !p.applicable || p.applicable(ctx));
  if (ctx.refresh) await Promise.all(providers.map((p) => p.refresh?.(ctx).catch(() => undefined)));
  const rows = await Promise.all(
    providers.map(async (p): Promise<ServiceUsage> => {
      try {
        return await p.collect(ctx);
      } catch (e) {
        return { service: p.id, label: p.label, kind: p.kind, status: 'unknown', statusSource: 'unknown', statusNote: `provider failed: ${(e as Error).message}`, metrics: [] };
      }
    }),
  );
  return o.includeMissing ? rows : rows.filter((r) => !(r.status === 'unavailable' && /not installed/i.test(r.statusNote ?? '')));
}

import type { Availability } from '../exec/strategy.js';
export type { Availability };

/** Service qui porte les limites d'une cible (le backend, sauf exceptions). */
const serviceOf = (t: Target): string => t.backend;

/**
 * Une cible est-elle utilisable maintenant ? Décision fondée sur l'état observé : épuisée / authentification en échec /
 * indisponible → non ; limite proche → oui avec prudence ; inconnu → oui (on n'invente pas de blocage).
 */
export function availabilityFor(target: Target, services: ServiceUsage[], now = Date.now()): Availability {
  const s = services.find((x) => x.service === serviceOf(target));
  if (!s) return { ok: true };
  const reset = s.metrics.find((m) => m.resetAt && m.resetAt > now)?.resetAt;
  const when = reset ? ` (reset ${new Date(reset).toISOString().slice(11, 16)} UTC)` : '';
  switch (s.status) {
    case 'exhausted':
      return { ok: false, reason: `${s.label} exhausted${when}` };
    case 'auth_error':
      return { ok: false, reason: `${s.label} authentication failed` };
    case 'unavailable':
      return { ok: false, reason: `${s.label} unavailable${s.statusNote ? `: ${s.statusNote}` : ''}` };
    case 'limited': {
      const w = headlineWindow(s);
      return { ok: true, caution: `${s.label} close to its limit${typeof w?.value === 'number' ? ` (${Math.round(w.value * 100)}%)` : ''}${when}` };
    }
    default:
      return { ok: true };
  }
}

/** Enregistre un incident de limite constaté pendant une exécution (429, quota dépassé, authentification, indisponibilité). */
export function noteAgentError(service: string, error: { kind: string; message: string }, now = Date.now()): Incident | null {
  const kind: Incident['kind'] | null = /\b429\b|rate[- ]?limit|too many requests/i.test(error.message) ? 'rate_limit' : error.kind === 'quota' ? 'quota' : error.kind === 'auth' ? 'auth' : error.kind === 'unavailable' ? 'unavailable' : null;
  if (!kind) return null;
  const hint = parseResetHint(error.message, now);
  const inc: Incident = { service, kind, at: now, resetAt: hint ?? undefined, resetSource: hint ? 'estimated' : 'unknown', message: error.message };
  recordIncident(inc);
  return inc;
}

export { activeIncident };

export interface UsageRow {
  service: string;
  label: string;
  kind: 'cloud' | 'local';
  status: ServiceUsage['status'];
  /** 0..1, null si inconnu ou sans objet (local) */
  ratio: number | null;
  ratioSource: UsageMetric['source'] | null;
  /** fenêtre affichée (window_5h…) */
  window?: string;
  resetAt?: number;
  confidence: Confidence;
  note?: string;
}

/** Une ligne par service : le tableau « Service / Statut / Usage / Reset / Confiance ». */
export function usageRows(services: ServiceUsage[]): UsageRow[] {
  return services.map((s) => {
    const h = headlineWindow(s);
    const local = s.kind === 'local';
    return {
      service: s.service,
      label: s.label,
      kind: s.kind,
      status: s.status,
      ratio: h && typeof h.value === 'number' ? h.value : null,
      ratioSource: h?.source ?? null,
      window: h?.metric,
      resetAt: h?.resetAt,
      confidence: h ? h.confidence : local ? 'high' : 'low',
      note: s.statusNote,
    };
  });
}

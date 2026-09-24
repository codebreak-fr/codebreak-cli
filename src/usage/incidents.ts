import { usageIncidentsPath } from '../config/paths.js';
import { readJson, writeJson } from '../util/store.js';
import { redact } from '../util/redact.js';
import type { MetricSource } from './types.js';

/**
 * Incidents de limite réellement constatés (429, quota dépassé, authentification expirée, service indisponible).
 * C'est de l'observation : la date de reset, elle, n'est observée que si l'erreur la donne (sinon estimée ou inconnue).
 */
export interface Incident {
  service: string;
  kind: 'quota' | 'auth' | 'unavailable' | 'rate_limit';
  at: number;
  /** epoch ms de la remise à zéro annoncée ou estimée */
  resetAt?: number;
  resetSource: MetricSource;
  message: string;
}

const MAX = 100;
/** Sans échéance connue, un refus n'est retenu que peu de temps : sinon on n'appellerait plus jamais le service. */
export const UNKNOWN_RESET_TTL_MS = 30 * 60_000;

const load = (path: string) => readJson<Incident[]>(path, []);

export function recordIncident(inc: Incident, path = usageIncidentsPath()): void {
  const list = [...load(path), { ...inc, message: redact(inc.message).slice(0, 300) }].slice(-MAX);
  writeJson(path, list);
}

export function clearIncidents(service: string, path = usageIncidentsPath()): void {
  writeJson(path, load(path).filter((i) => i.service !== service));
}

export function incidentsFor(service: string, now: number, windowMs = 6 * 3_600_000, path = usageIncidentsPath()): Incident[] {
  return load(path).filter((i) => i.service === service && now - i.at <= windowMs);
}

/** Incident encore « actif » : échéance de reset dans le futur, ou récent quand elle est inconnue. */
export function activeIncident(service: string, now: number, path = usageIncidentsPath()): Incident | undefined {
  return incidentsFor(service, now, 7 * 864e5, path)
    .filter((i) => (i.resetAt !== undefined ? i.resetAt > now : now - i.at < UNKNOWN_RESET_TTL_MS))
    .sort((a, b) => b.at - a.at)[0];
}

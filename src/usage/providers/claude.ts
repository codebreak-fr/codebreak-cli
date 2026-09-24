import type { Config } from '../../config/schema.js';
import type { ClaudeUsage, QuotaWindow } from '../../types.js';
import { getClaudeUsage, loadUsage } from '../claude.js';
import { activeIncident } from '../incidents.js';
import { freshness, unknownMetric, type ServiceStatus, type ServiceUsage, type UsageContext, type UsageMetric, type UsageProvider } from '../types.js';

const ORIGIN = 'claude-code:rate_limit_event';

/** Fenêtre → métrique. Une fenêtre dont l'échéance est passée vaut 0 : c'est alors une ESTIMATION, pas une observation. */
export function windowMetric(name: 'window_5h' | 'window_7d', w: QuotaWindow | undefined, fetchedAt: number | undefined, now: number): UsageMetric {
  if (!w) return unknownMetric('claude', name, 'no window reported by Claude Code yet', 'ratio');
  const observedAt = w.observedAt ?? fetchedAt ?? null;
  const resetAt = w.resetsAt ? w.resetsAt * 1000 : undefined;
  if (resetAt !== undefined && resetAt < now) {
    return { service: 'claude', metric: name, value: 0, unit: 'ratio', source: 'estimated', origin: ORIGIN, observedAt, resetAt, confidence: 'medium', note: 'reset time has passed: utilisation assumed back to 0' };
  }
  return { service: 'claude', metric: name, value: w.utilization, unit: 'ratio', source: 'observed', origin: ORIGIN, observedAt, resetAt, confidence: freshness(observedAt, now), note: observedAt !== null && now - observedAt > 120 * 60_000 ? 'stale observation' : undefined };
}

export function assessClaude(usage: ClaudeUsage | null, cfg: Pick<Config, 'quota'>, now: number, incident?: ReturnType<typeof activeIncident>): { status: ServiceStatus; source: 'observed' | 'estimated' | 'unknown'; note?: string } {
  if (incident) {
    return { status: incident.kind === 'auth' ? 'auth_error' : 'exhausted', source: 'observed', note: `${incident.kind} incident${incident.resetAt ? '' : ' (reset unknown)'}` };
  }
  if (!usage) return { status: 'unknown', source: 'unknown', note: 'no usage observed yet' };
  const recentlyRejected = usage.status === 'rejected' && now - usage.fetchedAt < 30 * 60_000;
  if (recentlyRejected) return { status: 'exhausted', source: 'observed', note: 'last request was rejected' };
  const w5 = windowMetric('window_5h', usage.fiveHour, usage.fetchedAt, now);
  const w7 = windowMetric('window_7d', usage.sevenDay, usage.fetchedAt, now);
  const values = [w5, w7].filter((m) => typeof m.value === 'number');
  if (!values.length) return { status: 'unknown', source: 'unknown', note: 'no window observed' };
  const u = Math.max(...values.map((m) => m.value as number));
  const source = values.some((m) => m.source === 'observed') ? 'observed' : 'estimated';
  const q = cfg.quota.claude;
  if (u >= q.stop) return { status: 'exhausted', source };
  if (u >= q.hard || usage.status === 'allowed_warning') return { status: 'limited', source };
  return { status: 'available', source };
}

export const claudeProvider: UsageProvider & { refresh(ctx: UsageContext): Promise<void> } = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'cloud',
  async refresh(ctx) {
    if (ctx.det.claude.ready) await getClaudeUsage(ctx.det.claude.path, ctx.cfg, { force: true });
  },
  async collect(ctx): Promise<ServiceUsage> {
    const base = { service: 'claude', label: 'Claude Code', kind: 'cloud' as const };
    if (!ctx.det.claude.installed) return { ...base, status: 'unavailable', statusSource: 'observed', statusNote: 'Claude Code not installed', metrics: [] };
    if (!ctx.det.claude.ready) return { ...base, status: 'auth_error', statusSource: 'observed', statusNote: ctx.det.claude.detail, metrics: [] };

    const usage = loadUsage();
    const incident = activeIncident('claude', ctx.now);
    const metrics: UsageMetric[] = [windowMetric('window_5h', usage?.fiveHour, usage?.fetchedAt, ctx.now), windowMetric('window_7d', usage?.sevenDay, usage?.fetchedAt, ctx.now)];
    if (usage?.status) metrics.push({ service: 'claude', metric: 'rate_limit_status', value: usage.status, unit: 'text', source: 'observed', origin: ORIGIN, observedAt: usage.fetchedAt, confidence: freshness(usage.fetchedAt, ctx.now) });
    if (usage?.rateLimitType) metrics.push({ service: 'claude', metric: 'representative_window', value: usage.rateLimitType, unit: 'text', source: 'observed', origin: ORIGIN, observedAt: usage.fetchedAt, confidence: freshness(usage.fetchedAt, ctx.now) });
    if (usage?.overage) {
      metrics.push({ service: 'claude', metric: 'overage', value: usage.overage.using ? 'in use' : (usage.overage.status ?? 'unknown'), unit: 'text', source: 'observed', origin: ORIGIN, observedAt: usage.fetchedAt, confidence: freshness(usage.fetchedAt, ctx.now), note: usage.overage.reason });
    }
    if (incident) metrics.push({ service: 'claude', metric: 'last_incident', value: incident.kind, unit: 'text', source: 'observed', origin: 'agent error', observedAt: incident.at, resetAt: incident.resetAt, confidence: 'high', note: incident.message });
    const a = assessClaude(usage, ctx.cfg, ctx.now, incident);
    return { ...base, status: a.status, statusSource: a.source, statusNote: a.note, metrics };
  },
};

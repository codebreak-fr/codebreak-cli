import { usageIncidentsPath } from '../../config/paths.js';
import { readJson, writeJson } from '../../util/store.js';
import { parseApiKeyLimits, parseOpenAiLimits, type LimitPair } from '../anthropic-headers.js';
import { recordIncident } from '../incidents.js';
import { parseResetHint } from '../reset.js';
import { unknownMetric, type ServiceStatus, type ServiceUsage, type UsageContext, type UsageMetric, type UsageProvider } from '../types.js';

/**
 * Sondes d'API avec la clé de l'utilisateur, en opt-in (`usage.api_probes.*`) : une requête d'1 token dont on lit les
 * en-têtes de limite. Jamais d'identifiants volés à un autre outil (ex. jeton OAuth de Claude Code).
 */

interface Probe {
  at: number;
  status: number;
  headers: Record<string, string>;
}

const probePath = (id: string) => usageIncidentsPath().replace('usage-incidents.json', `usage-probe-${id}.json`);

function pairMetrics(service: string, origin: string, name: string, p: LimitPair | undefined, observedAt: number, cfgHard: number): { metrics: UsageMetric[]; ratio?: number } {
  if (!p) return { metrics: [] };
  const metrics: UsageMetric[] = [];
  const base = { service, unit: 'count' as const, source: 'observed' as const, origin, observedAt, confidence: 'high' as const };
  if (p.remaining !== undefined) metrics.push({ ...base, metric: `${name}_remaining`, value: p.remaining, unit: name === 'tokens' ? 'tokens' : 'requests', resetAt: p.resetAt });
  if (p.limit !== undefined) metrics.push({ ...base, metric: `${name}_limit`, value: p.limit, unit: name === 'tokens' ? 'tokens' : 'requests' });
  let ratio: number | undefined;
  if (p.limit && p.remaining !== undefined && p.limit > 0) {
    ratio = Math.min(1, Math.max(0, 1 - p.remaining / p.limit));
    metrics.push({ ...base, metric: `window_${name}`, value: ratio, unit: 'ratio', resetAt: p.resetAt, note: `derived from ${name}_limit and ${name}_remaining (limit ${cfgHard})` });
  }
  return { metrics, ratio };
}

function statusFrom(ratios: number[], remaining: (number | undefined)[], hard: number, stop: number): ServiceStatus {
  if (remaining.some((r) => r === 0)) return 'exhausted';
  const max = Math.max(0, ...ratios);
  if (!ratios.length) return 'unknown';
  return max >= stop ? 'exhausted' : max >= hard ? 'limited' : 'available';
}

interface ApiSpec {
  id: 'anthropic-api' | 'openai-api';
  label: string;
  envKey: string;
  enabled(ctx: UsageContext): boolean;
  model(ctx: UsageContext): string;
  request(key: string, model: string): { url: string; init: RequestInit };
  parse(h: Record<string, string>, now: number): { metricsFor(now: number): { metrics: UsageMetric[]; ratios: number[]; remaining: (number | undefined)[]; retryAfterS?: number } };
}

const lower = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
};

const SPECS: ApiSpec[] = [
  {
    id: 'anthropic-api',
    label: 'Anthropic API',
    envKey: 'ANTHROPIC_API_KEY',
    enabled: (ctx) => ctx.cfg.usage.api_probes.anthropic,
    model: (ctx) => ctx.cfg.usage.probe_models.anthropic,
    request: (key, model) => ({
      url: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }) },
    }),
    parse: (h, now) => ({
      metricsFor: () => {
        const l = parseApiKeyLimits(h);
        const origin = 'anthropic-api:headers';
        const parts = (['requests', 'tokens', 'inputTokens', 'outputTokens'] as const).map((k) => pairMetrics('anthropic-api', origin, k === 'inputTokens' ? 'input_tokens' : k === 'outputTokens' ? 'output_tokens' : k, l[k], now, 0.9));
        return { metrics: parts.flatMap((p) => p.metrics), ratios: parts.flatMap((p) => (p.ratio === undefined ? [] : [p.ratio])), remaining: (['requests', 'tokens', 'inputTokens', 'outputTokens'] as const).map((k) => l[k]?.remaining), retryAfterS: l.retryAfterS };
      },
    }),
  },
  {
    id: 'openai-api',
    label: 'OpenAI API',
    envKey: 'OPENAI_API_KEY',
    enabled: (ctx) => ctx.cfg.usage.api_probes.openai && ctx.cfg.usage.probe_models.openai !== '',
    model: (ctx) => ctx.cfg.usage.probe_models.openai,
    request: (key, model) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      init: { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }) },
    }),
    parse: (h, now) => ({
      metricsFor: () => {
        const l = parseOpenAiLimits(h, now);
        const origin = 'openai-api:headers';
        const parts = (['requests', 'tokens'] as const).map((k) => pairMetrics('openai-api', origin, k, l[k], now, 0.9));
        return { metrics: parts.flatMap((p) => p.metrics), ratios: parts.flatMap((p) => (p.ratio === undefined ? [] : [p.ratio])), remaining: [l.requests?.remaining, l.tokens?.remaining], retryAfterS: Number(h['retry-after']) || undefined };
      },
    }),
  },
];

async function probe(spec: ApiSpec, ctx: UsageContext, key: string): Promise<Probe | null> {
  const path = probePath(spec.id);
  const cached = readJson<Probe | null>(path, null);
  if (!ctx.refresh && cached && ctx.now - cached.at < ctx.cfg.usage.ttl_minutes * 60_000) return cached;
  try {
    const { url, init } = spec.request(key, spec.model(ctx));
    const res = await ctx.fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const result: Probe = { at: ctx.now, status: res.status, headers: lower(res.headers) };
    writeJson(path, result);
    return result;
  } catch {
    return cached;
  }
}

function apiProvider(spec: ApiSpec): UsageProvider & { applicable(ctx: UsageContext): boolean } {
  return {
    id: spec.id,
    label: spec.label,
    kind: 'cloud',
    applicable: (ctx) => Boolean(ctx.env[spec.envKey]),
    async collect(ctx): Promise<ServiceUsage> {
      const base = { service: spec.id, label: spec.label, kind: 'cloud' as const };
      const key = ctx.env[spec.envKey];
      if (!key) return { ...base, status: 'unknown', statusSource: 'unknown', metrics: [] };
      if (!spec.enabled(ctx)) {
        return { ...base, status: 'unknown', statusSource: 'unknown', statusNote: `limits not read: probe disabled (usage.api_probes, ${spec.model(ctx) ? 'sends one 1-token request' : 'set usage.probe_models first'})`, metrics: [unknownMetric(spec.id, 'rate_limits', 'enable usage.api_probes to read the rate-limit headers with your own key')] };
      }
      const p = await probe(spec, ctx, key);
      if (!p) return { ...base, status: 'unknown', statusSource: 'unknown', statusNote: 'probe failed (network?)', metrics: [] };
      if (p.status === 401 || p.status === 403) {
        recordIncident({ service: spec.id, kind: 'auth', at: p.at, resetSource: 'unknown', message: `HTTP ${p.status}` });
        return { ...base, status: 'auth_error', statusSource: 'observed', statusNote: `HTTP ${p.status}`, metrics: [] };
      }
      const parsed = spec.parse(p.headers, p.at).metricsFor(p.at);
      if (p.status === 429) {
        const retry = parsed.retryAfterS ? p.at + parsed.retryAfterS * 1000 : parseResetHint(JSON.stringify(p.headers), p.at) ?? undefined;
        recordIncident({ service: spec.id, kind: 'rate_limit', at: p.at, resetAt: retry, resetSource: retry ? (parsed.retryAfterS ? 'observed' : 'estimated') : 'unknown', message: 'HTTP 429' });
        return { ...base, status: 'exhausted', statusSource: 'observed', statusNote: 'HTTP 429', metrics: parsed.metrics };
      }
      const q = ctx.cfg.quota.claude;
      const status = statusFrom(parsed.ratios, parsed.remaining, q.hard, q.stop);
      return { ...base, status, statusSource: status === 'unknown' ? 'unknown' : 'observed', statusNote: status === 'unknown' ? 'no rate-limit headers in the response' : undefined, metrics: parsed.metrics.length ? parsed.metrics : [unknownMetric(spec.id, 'rate_limits', 'the response carried no rate-limit headers')] };
    },
  };
}

export const anthropicApiProvider = apiProvider(SPECS[0]!);
export const openaiApiProvider = apiProvider(SPECS[1]!);

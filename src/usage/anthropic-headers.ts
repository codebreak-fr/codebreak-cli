import type { ClaudeUsage, QuotaWindow } from '../types.js';

/**
 * En-têtes de limite renvoyés par l'API Anthropic. Deux familles :
 *  - clé API : `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (+ `retry-after`) ;
 *  - abonnement (« unified ») : `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}`, `-status`,
 *    `-representative-claim`, `-overage-*` — c'est ce que Claude Code reflète dans ses événements `rate_limit_event`.
 * Le parseur est tolérant : il ne retient que ce qui est présent et bien formé.
 */

export type HeaderBag = Headers | Record<string, string | undefined>;

const get = (h: HeaderBag, name: string): string | undefined => {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  return key ? rec[key] : undefined;
};

const keys = (h: HeaderBag): string[] => {
  if (typeof (h as Headers).forEach === 'function') {
    const out: string[] = [];
    (h as Headers).forEach((_v, k) => out.push(k.toLowerCase()));
    return out;
  }
  return Object.keys(h).map((k) => k.toLowerCase());
};

const num = (s: string | undefined) => (s !== undefined && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** `reset` : RFC 3339 (API) ou epoch en secondes (unified). → epoch ms */
export function parseResetValue(s: string | undefined): number | undefined {
  if (!s) return undefined;
  if (/^\d{9,11}$/.test(s.trim())) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

export interface LimitPair {
  limit?: number;
  remaining?: number;
  /** epoch ms */
  resetAt?: number;
}

export interface ApiKeyLimits {
  requests?: LimitPair;
  tokens?: LimitPair;
  inputTokens?: LimitPair;
  outputTokens?: LimitPair;
  /** secondes */
  retryAfterS?: number;
}

export function parseApiKeyLimits(h: HeaderBag): ApiKeyLimits {
  const pair = (prefix: string): LimitPair | undefined => {
    const limit = num(get(h, `${prefix}-limit`));
    const remaining = num(get(h, `${prefix}-remaining`));
    const resetAt = parseResetValue(get(h, `${prefix}-reset`));
    return limit === undefined && remaining === undefined && resetAt === undefined ? undefined : { limit, remaining, resetAt };
  };
  return {
    requests: pair('anthropic-ratelimit-requests'),
    tokens: pair('anthropic-ratelimit-tokens'),
    inputTokens: pair('anthropic-ratelimit-input-tokens'),
    outputTokens: pair('anthropic-ratelimit-output-tokens'),
    retryAfterS: num(get(h, 'retry-after')),
  };
}

/** Fenêtres « unified » (abonnement) : 5 h et 7 j, statut global, fenêtre représentative, dépassement. */
export function parseUnifiedHeaders(h: HeaderBag, now = Date.now()): Partial<ClaudeUsage> & { overage?: NonNullable<ClaudeUsage['overage']> } | null {
  const names = keys(h).filter((k) => k.startsWith('anthropic-ratelimit-unified-'));
  if (!names.length) return null;
  const win = (tag: '5h' | '7d'): QuotaWindow | undefined => {
    const utilization = num(get(h, `anthropic-ratelimit-unified-${tag}-utilization`));
    if (utilization === undefined) return undefined;
    const reset = parseResetValue(get(h, `anthropic-ratelimit-unified-${tag}-reset`));
    return { utilization, resetsAt: reset ? Math.floor(reset / 1000) : undefined, observedAt: now };
  };
  const overageStatus = get(h, 'anthropic-ratelimit-unified-overage-status');
  const representative = get(h, 'anthropic-ratelimit-unified-representative-claim');
  return {
    fiveHour: win('5h'),
    sevenDay: win('7d'),
    status: get(h, 'anthropic-ratelimit-unified-status'),
    rateLimitType: representative,
    overage: overageStatus ? { status: overageStatus } : undefined,
  };
}

/** Familles OpenAI-compatibles (`x-ratelimit-{limit,remaining,reset}-{requests,tokens}`), utilisées par plusieurs fournisseurs. */
export function parseOpenAiLimits(h: HeaderBag, now = Date.now()): { requests?: LimitPair; tokens?: LimitPair } {
  const dur = (s: string | undefined): number | undefined => {
    if (!s) return undefined;
    let ms = 0;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) ms += Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 864e5 } as Record<string, number>)[m[2]!]!;
    return ms > 0 ? now + ms : undefined;
  };
  const pair = (what: 'requests' | 'tokens'): LimitPair | undefined => {
    const limit = num(get(h, `x-ratelimit-limit-${what}`));
    const remaining = num(get(h, `x-ratelimit-remaining-${what}`));
    const resetAt = dur(get(h, `x-ratelimit-reset-${what}`));
    return limit === undefined && remaining === undefined && resetAt === undefined ? undefined : { limit, remaining, resetAt };
  };
  return { requests: pair('requests'), tokens: pair('tokens') };
}

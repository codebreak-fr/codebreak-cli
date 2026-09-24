import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseApiKeyLimits, parseOpenAiLimits, parseUnifiedHeaders, parseResetValue } from '../src/usage/anthropic-headers.js';
import { parseRateLimitEvent, saveUsage } from '../src/usage/claude.js';
import { activeIncident, clearIncidents, recordIncident, UNKNOWN_RESET_TTL_MS } from '../src/usage/incidents.js';
import { availabilityFor, collectUsage, noteAgentError, usageRows } from '../src/usage/monitor.js';
import { anthropicApiProvider, openaiApiProvider } from '../src/usage/providers/api.js';
import { assessClaude, claudeProvider, windowMetric } from '../src/usage/providers/claude.js';
import { codexProvider, copilotProvider, geminiProvider, parseCodexRateLimits, parseOpencodeStats } from '../src/usage/providers/cloud.js';
import { ollamaProvider } from '../src/usage/providers/local.js';
import { parseResetHint } from '../src/usage/reset.js';
import { headlineWindow } from '../src/usage/types.js';
import { defaultCfg, detection, targetsOf } from './helpers.js';

const cfg = defaultCfg();
const NOW = Date.parse('2026-09-24T12:00:00Z');
const H = 3_600_000;
const T = targetsOf();

/** Événement réel de `claude -p --output-format stream-json` (capturé), tel quel. */
const REAL_EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1790256000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled_until',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.38, resetsAt: 1790256000 }, seven_day: { utilization: 0.15, resetsAt: 1790730000 } },
  },
};

beforeEach(() => {
  // état isolé par test (incidents, cache d'usage, sondes)
  process.env.CODEBREAK_HOME = mkdtempSync(join(tmpdir(), 'cb-usage-'));
});

const opts = (over = {}) => ({ cfg, det: detection, now: NOW, home: mkdtempSync(join(tmpdir(), 'cb-home-')), env: {}, sampleMachine: async () => ({ ramFreeGB: 6.5, cpuLoad: 0.2, at: NOW }), fetchImpl: async () => new Response('{}'), ...over });

describe('Claude : fenêtres 5 h / 7 j (rate_limit_event)', () => {
  it('lit l’événement réel : fenêtres, statut, fenêtre représentative, dépassement, horodatage par fenêtre', () => {
    const p = parseRateLimitEvent(REAL_EVENT, NOW)!;
    expect(p.fiveHour).toEqual({ utilization: 0.38, resetsAt: 1790256000, observedAt: NOW });
    expect(p.sevenDay).toEqual({ utilization: 0.15, resetsAt: 1790730000, observedAt: NOW });
    expect(p).toMatchObject({ status: 'allowed', rateLimitType: 'five_hour', overage: { status: 'rejected', using: false, reason: 'org_level_disabled_until' } });
  });

  it('quota normal → disponible, valeurs OBSERVÉES avec source, horodatage et confiance', async () => {
    saveUsage(parseRateLimitEvent({ rate_limit_info: { ...REAL_EVENT.rate_limit_info, unifiedWindows: { five_hour: { utilization: 0.72, resetsAt: (NOW + 102 * 60_000) / 1000 }, seven_day: { utilization: 0.61, resetsAt: (NOW + 3 * 864e5) / 1000 } } } }, Date.now())!);
    const [c] = await collectUsage({ ...opts({ now: Date.now() }), providers: [claudeProvider] });
    expect(c).toMatchObject({ service: 'claude', status: 'available', statusSource: 'observed' });
    const w5 = c!.metrics.find((m) => m.metric === 'window_5h')!;
    expect(w5).toMatchObject({ value: 0.72, unit: 'ratio', source: 'observed', origin: 'claude-code:rate_limit_event', confidence: 'high' });
    expect(w5.observedAt).toBeGreaterThan(0);
    expect(w5.resetAt).toBeGreaterThan(Date.now());
    expect(headlineWindow(c!)!.metric).toBe('window_5h');
  });

  it('quota presque épuisé → limité ; dépassé ou refusé → épuisé', () => {
    const win = (u: number) => ({ utilization: u, resetsAt: (NOW + H) / 1000, observedAt: NOW });
    const usage = (u: number, status = 'allowed') => ({ fiveHour: win(u), sevenDay: win(0.1), status, fetchedAt: NOW });
    expect(assessClaude(usage(0.5), cfg, NOW).status).toBe('available');
    expect(assessClaude(usage(0.93), cfg, NOW).status).toBe('limited');
    expect(assessClaude(usage(0.6, 'allowed_warning'), cfg, NOW).status).toBe('limited');
    expect(assessClaude(usage(0.99), cfg, NOW).status).toBe('exhausted');
    expect(assessClaude(usage(0.3, 'rejected'), cfg, NOW).status).toBe('exhausted');
    // un refus ancien n'est pas retenu à vie
    expect(assessClaude({ ...usage(0.3, 'rejected'), fetchedAt: NOW - 2 * H }, cfg, NOW).status).toBe('available');
    expect(assessClaude(null, cfg, NOW)).toMatchObject({ status: 'unknown', source: 'unknown' });
  });

  it('échéance passée → 0 ESTIMÉ (jamais présenté comme observé) ; observation ancienne → confiance basse', () => {
    const expired = windowMetric('window_5h', { utilization: 0.95, resetsAt: (NOW - H) / 1000, observedAt: NOW - 6 * H }, undefined, NOW);
    expect(expired).toMatchObject({ value: 0, source: 'estimated', confidence: 'medium' });
    const stale = windowMetric('window_7d', { utilization: 0.4, resetsAt: (NOW + H) / 1000, observedAt: NOW - 5 * H }, undefined, NOW);
    expect(stale).toMatchObject({ value: 0.4, source: 'observed', confidence: 'low', note: 'stale observation' });
    expect(windowMetric('window_7d', undefined, undefined, NOW)).toMatchObject({ value: null, source: 'unknown' });
  });

  it('erreur 429 / quota : incident observé, reset ESTIMÉ à partir du message, puis expiration', async () => {
    const inc = noteAgentError('claude', { kind: 'quota', message: 'Claude usage limit reached. Resets in 2 hours 5 minutes' }, NOW)!;
    expect(inc).toMatchObject({ kind: 'quota', resetSource: 'estimated', resetAt: NOW + 2 * H + 5 * 60_000 });
    const [c] = await collectUsage({ ...opts(), providers: [claudeProvider] });
    expect(c).toMatchObject({ status: 'exhausted', statusSource: 'observed' });
    expect(activeIncident('claude', NOW + 3 * H)).toBeUndefined();
    // sans échéance connue : retenu peu de temps seulement
    clearIncidents('claude');
    noteAgentError('claude', { kind: 'quota', message: 'limit reached' }, NOW);
    expect(activeIncident('claude', NOW + 10 * 60_000)).toBeDefined();
    expect(activeIncident('claude', NOW + UNKNOWN_RESET_TTL_MS + 1000)).toBeUndefined();
  });

  it('échec d’authentification', async () => {
    const det = { ...detection, claude: { installed: true, ready: false, detail: 'non connecté' } };
    const [c] = await collectUsage({ ...opts({ det }), providers: [claudeProvider] });
    expect(c).toMatchObject({ status: 'auth_error', statusSource: 'observed' });
    noteAgentError('claude', { kind: 'auth', message: '401 invalid token' }, NOW);
    const [c2] = await collectUsage({ ...opts(), providers: [claudeProvider] });
    expect(c2!.status).toBe('auth_error');
  });
});

describe('en-têtes anthropic-ratelimit-*', () => {
  it('abonnement (unified) : 5 h et 7 j, statut, fenêtre représentative, dépassement', () => {
    const p = parseUnifiedHeaders(
      {
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1790256000',
        'anthropic-ratelimit-unified-7d-utilization': '0.18',
        'anthropic-ratelimit-unified-7d-reset': '1790730000',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-overage-status': 'rejected',
      },
      NOW,
    )!;
    expect(p.fiveHour).toEqual({ utilization: 0.42, resetsAt: 1790256000, observedAt: NOW });
    expect(p.sevenDay).toEqual({ utilization: 0.18, resetsAt: 1790730000, observedAt: NOW });
    expect(p).toMatchObject({ status: 'allowed', rateLimitType: 'five_hour', overage: { status: 'rejected' } });
    expect(parseUnifiedHeaders({ 'content-type': 'json' })).toBeNull();
    // une seule fenêtre présente : l'autre reste indéfinie (jamais inventée)
    expect(parseUnifiedHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.1' }, NOW)!.sevenDay).toBeUndefined();
  });

  it('clé API : requêtes, tokens, reset RFC 3339, retry-after ; insensible à la casse', () => {
    const l = parseApiKeyLimits({
      'Anthropic-RateLimit-Requests-Limit': '1000',
      'anthropic-ratelimit-requests-remaining': '999',
      'anthropic-ratelimit-requests-reset': '2026-09-24T12:01:00Z',
      'anthropic-ratelimit-tokens-limit': '80000',
      'anthropic-ratelimit-tokens-remaining': '0',
      'retry-after': '30',
    });
    expect(l.requests).toEqual({ limit: 1000, remaining: 999, resetAt: Date.parse('2026-09-24T12:01:00Z') });
    expect(l.tokens).toMatchObject({ limit: 80000, remaining: 0 });
    expect(l.inputTokens).toBeUndefined();
    expect(l.retryAfterS).toBe(30);
    expect(parseResetValue('not a date')).toBeUndefined();
  });

  it('famille OpenAI (x-ratelimit-*) avec durées « 6m0s »', () => {
    const l = parseOpenAiLimits({ 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-remaining-tokens': '9000' }, NOW);
    expect(l.requests).toEqual({ limit: 500, remaining: 499, resetAt: NOW + 6 * 60_000 });
    expect(l.tokens).toMatchObject({ remaining: 9000 });
  });
});

describe('indices de reset dans les messages', () => {
  it.each([
    ['resets in 2 hours 5 minutes', NOW + 2 * H + 5 * 60_000],
    ['try again in 45 minutes', NOW + 45 * 60_000],
    ['retry after 30s', NOW + 30_000],
    ['Retry-After: 120', NOW + 120_000],
    ['limit will reset |1790256000', 1790256000 * 1000],
    ['dans 1h30', NOW + 90 * 60_000],
  ])('%s', (msg, expected) => expect(parseResetHint(msg, NOW)).toBe(expected));
  it('heure locale : prochaine occurrence ; sinon null', () => {
    const at = parseResetHint('Your limit resets at 3pm', NOW)!;
    expect(at).toBeGreaterThan(NOW);
    expect(at - NOW).toBeLessThanOrEqual(24 * H);
    expect(new Date(at).getHours()).toBe(15);
    expect(parseResetHint('something went wrong', NOW)).toBeNull();
  });
});

describe('autres agents : unknown plutôt qu’un faux pourcentage', () => {
  it('Copilot : disponible (détecté) mais consommation inconnue, avec la raison', async () => {
    const [c] = await collectUsage({ ...opts(), providers: [copilotProvider] });
    expect(c).toMatchObject({ service: 'copilot', status: 'available', statusSource: 'observed' });
    const q = c!.metrics.find((m) => m.metric === 'quota')!;
    expect(q).toMatchObject({ value: null, source: 'unknown' });
    expect(q.note).toMatch(/no local or documented usage interface/);
    expect(usageRows([c!])[0]).toMatchObject({ ratio: null, confidence: 'low' });
  });

  it('OpenCode indisponible → masqué (non installé) ; Gemini : type d’authentification observé, quota inconnu', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cb-gem-'));
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
    const det = { ...detection, opencode: { ...detection.opencode, installed: false } };
    const rows = await collectUsage({ ...opts({ det, home }), providers: [geminiProvider] });
    expect(rows[0]!.metrics.find((m) => m.metric === 'auth_type')).toMatchObject({ value: 'gemini-api-key', source: 'observed' });
    expect(rows[0]!.metrics.find((m) => m.metric === 'quota')).toMatchObject({ source: 'unknown' });
    const hidden = await collectUsage({ ...opts({ det: { ...detection, gemini: { ...detection.gemini, installed: false } } }), providers: [geminiProvider] });
    expect(hidden).toEqual([]);
  });

  it('OpenCode : usage local lu dans `opencode stats`', () => {
    const text = '│Sessions                                            130 │\n│Total Cost                                        $0.00 │\n│Input                                             18.3M │\n│Output                                             1.8M │';
    expect(parseOpencodeStats(text)).toEqual({ sessions: 130, cost: 0, input: 18_300_000, output: 1_800_000 });
  });

  it('Codex : fenêtres lues dans les journaux de session locaux (5 h / 7 j)', async () => {
    const line = JSON.stringify({ timestamp: '2026-09-24T11:55:00Z', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 41, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 12, window_minutes: 10080, resets_in_seconds: 200000 } } } });
    const parsed = parseCodexRateLimits(`garbage\n${line}\n{"broken`, NOW)!;
    expect(parsed.windows).toHaveLength(2);
    const home = mkdtempSync(join(tmpdir(), 'cb-codex-'));
    mkdirSync(join(home, '.codex', 'sessions', '2026', '09'), { recursive: true });
    writeFileSync(join(home, '.codex', 'sessions', '2026', '09', 'rollout-a.jsonl'), line + '\n');
    const [c] = await collectUsage({ ...opts({ home }), providers: [codexProvider] });
    expect(c!.metrics.map((m) => [m.metric, m.value, m.confidence])).toEqual([['window_5h', 0.41, 'medium'], ['window_7d', 0.12, 'medium']]);
    expect(c!.status).toBe('available');
    // pas de dossier Codex : le fournisseur n'apparaît pas
    expect(await collectUsage({ ...opts(), providers: [codexProvider] })).toEqual([]);
  });
});

describe('sondes d’API (opt-in, avec TA clé)', () => {
  const headersFetch = (status: number, headers: Record<string, string>) => async () => new Response('{}', { status, headers });
  const env = { ANTHROPIC_API_KEY: 'sk-ant-test-key-not-real' };
  const on = { ...cfg, usage: { ...cfg.usage, api_probes: { ...cfg.usage.api_probes, anthropic: true } } };

  it('sans clé : absent ; avec clé mais sonde désactivée : unknown + comment l’activer', async () => {
    expect(await collectUsage({ ...opts(), providers: [anthropicApiProvider] })).toEqual([]);
    const [a] = await collectUsage({ ...opts({ env }), providers: [anthropicApiProvider] });
    expect(a).toMatchObject({ status: 'unknown', statusSource: 'unknown' });
    expect(a!.statusNote).toMatch(/probe disabled/);
  });

  it('sonde activée : requêtes et tokens restants, utilisation dérivée, statut observé', async () => {
    const fetchImpl = headersFetch(200, { 'anthropic-ratelimit-requests-limit': '1000', 'anthropic-ratelimit-requests-remaining': '400', 'anthropic-ratelimit-requests-reset': '2026-09-24T12:01:00Z', 'anthropic-ratelimit-tokens-limit': '100000', 'anthropic-ratelimit-tokens-remaining': '99000' });
    const [a] = await collectUsage({ ...opts({ env, cfg: on, fetchImpl }), providers: [anthropicApiProvider] });
    expect(a!.metrics.find((m) => m.metric === 'requests_remaining')).toMatchObject({ value: 400, source: 'observed', origin: 'anthropic-api:headers', confidence: 'high' });
    expect(a!.metrics.find((m) => m.metric === 'window_requests')).toMatchObject({ value: 0.6, unit: 'ratio' });
    expect(a!.status).toBe('available');
  });

  it('429 → épuisé + incident avec retry-after OBSERVÉ ; 401 → authentification', async () => {
    const [a] = await collectUsage({ ...opts({ env, cfg: on, fetchImpl: headersFetch(429, { 'retry-after': '30', 'anthropic-ratelimit-requests-remaining': '0' }) }), providers: [anthropicApiProvider] });
    expect(a).toMatchObject({ status: 'exhausted', statusSource: 'observed' });
    expect(activeIncident('anthropic-api', NOW + 1000)).toMatchObject({ kind: 'rate_limit', resetSource: 'observed' });
    process.env.CODEBREAK_HOME = mkdtempSync(join(tmpdir(), 'cb-usage-'));
    const [b] = await collectUsage({ ...opts({ env, cfg: on, fetchImpl: headersFetch(401, {}), now: NOW + 1 }), providers: [anthropicApiProvider] });
    expect(b!.status).toBe('auth_error');
  });

  it('réponse sans en-têtes de limite : unknown, jamais inventé ; OpenAI sans modèle configuré : sonde impossible', async () => {
    const [a] = await collectUsage({ ...opts({ env, cfg: on, fetchImpl: headersFetch(200, {}) }), providers: [anthropicApiProvider] });
    expect(a).toMatchObject({ status: 'unknown' });
    const oa = { ...cfg, usage: { ...cfg.usage, api_probes: { anthropic: false, openai: true } } };
    const [o] = await collectUsage({ ...opts({ env: { OPENAI_API_KEY: 'x' }, cfg: oa }), providers: [openaiApiProvider] });
    expect(o!.statusNote).toMatch(/set usage\.probe_models first/);
  });
});

describe('services locaux : ressources et capacités, pas de quota cloud', () => {
  it('Ollama : RAM/CPU observés, modèles chargés via /api/ps, vitesse inconnue tant que rien n’est mesuré', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5e9, context_length: 32768 }] }));
    const [o] = await collectUsage({ ...opts({ fetchImpl }), providers: [ollamaProvider] });
    expect(o).toMatchObject({ service: 'ollama', kind: 'local', status: 'available' });
    const by = Object.fromEntries(o!.metrics.map((m) => [m.metric, m]));
    expect(by.ram_free_gb).toMatchObject({ value: 6.5, source: 'observed' });
    expect(by.models_loaded).toMatchObject({ value: 'qwen3:8b', origin: 'ollama /api/ps' });
    expect(by.context_length!.value).toBe(32768);
    expect(by.tokens_per_s).toMatchObject({ value: null, source: 'unknown' });
    expect(usageRows([o!])[0]).toMatchObject({ ratio: null });
  });
});

describe('agrégation et disponibilité', () => {
  it('un fournisseur qui plante devient unknown sans casser les autres', async () => {
    const boom = { id: 'boom', label: 'Boom', kind: 'cloud' as const, collect: async () => { throw new Error('kaput'); } };
    const rows = await collectUsage({ ...opts(), providers: [boom, copilotProvider] });
    expect(rows.map((r) => [r.service, r.status])).toEqual([['boom', 'unknown'], ['copilot', 'available']]);
    expect(rows[0]!.statusNote).toMatch(/kaput/);
  });

  it('cible écartée si épuisée / authentification / indisponible, prudence si limitée, sinon libre', async () => {
    saveUsage({ fiveHour: { utilization: 0.95, resetsAt: (NOW + H) / 1000, observedAt: NOW }, fetchedAt: NOW, status: 'allowed' });
    let rows = await collectUsage({ ...opts(), providers: [claudeProvider, copilotProvider] });
    expect(availabilityFor(T['claude:sonnet']!, rows, NOW)).toMatchObject({ ok: true, caution: expect.stringMatching(/close to its limit \(95%\)/) });
    expect(availabilityFor(T['copilot:agent']!, rows, NOW)).toEqual({ ok: true });
    expect(availabilityFor(T['ollama:ministral-3:8b']!, rows, NOW)).toEqual({ ok: true });
    recordIncident({ service: 'claude', kind: 'quota', at: NOW, resetAt: NOW + H, resetSource: 'estimated', message: 'limit' });
    rows = await collectUsage({ ...opts(), providers: [claudeProvider] });
    expect(availabilityFor(T['claude:opus']!, rows, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/exhausted/) });
  });

  it('tableau de synthèse : service, statut, usage (avec provenance), reset, confiance', async () => {
    saveUsage({ fiveHour: { utilization: 0.72, resetsAt: (NOW + 102 * 60_000) / 1000, observedAt: NOW }, sevenDay: { utilization: 0.61, resetsAt: (NOW + 3 * 864e5) / 1000, observedAt: NOW }, fetchedAt: NOW, status: 'allowed' });
    const rows = await collectUsage({ ...opts(), providers: [claudeProvider, copilotProvider, ollamaProvider] });
    const table = usageRows(rows);
    expect(table[0]).toMatchObject({ service: 'claude', status: 'available', ratio: 0.72, ratioSource: 'observed', window: 'window_5h', confidence: 'high' });
    expect(table[1]).toMatchObject({ service: 'copilot', ratio: null, ratioSource: null });
    expect(table[2]).toMatchObject({ service: 'ollama', kind: 'local', ratio: null });
  });
});

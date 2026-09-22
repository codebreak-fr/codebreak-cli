import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { mapClaudeEvent } from '../src/backends/claude.js';
import { mapGeminiEvent } from '../src/backends/gemini.js';
import { mapOpencodeEvent } from '../src/backends/opencode.js';
import { mapVibeEntry } from '../src/backends/vibe.js';
import { deepMerge, loadConfig, setConfigValue } from '../src/config/load.js';
import { ConfigSchema } from '../src/config/schema.js';
import { detectVerifyCommands } from '../src/exec/verify.js';
import { classifyMemory, parsePmset, parseVmStat } from '../src/detect/hardware.js';
import { parseLlmJson, pickRouterModel } from '../src/router/classifier.js';
import { containsSecret } from '../src/router/index.js';
import { effectiveUtilization, mergeUsage, parseRateLimitEvent, quotaState } from '../src/usage/claude.js';
import { recentFailureRate, summarize, usageByBackend, type LedgerEntry } from '../src/usage/ledger.js';
import { detection, tempHome } from './helpers.js';

const cfg = ConfigSchema.parse({});

describe('quota Claude', () => {
  const ev = {
    rate_limit_info: {
      status: 'allowed_warning', resetsAt: 1790125200, rateLimitType: 'seven_day', utilization: 0.92,
      unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: 1789996800 }, seven_day: { utilization: 0.92, resetsAt: 1790125200 } },
    },
  };
  it('parse les deux fenêtres', () => {
    const u = parseRateLimitEvent(ev)!;
    expect(u.fiveHour?.utilization).toBe(0.01);
    expect(u.sevenDay?.utilization).toBe(0.92);
  });
  it('événement à fenêtre unique', () => {
    const u = parseRateLimitEvent({ rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, resetsAt: 5 } })!;
    expect(u.fiveHour?.utilization).toBe(0.4);
  });
  it('états ok / soft / hard / stop selon la fenêtre la plus chargée', () => {
    const now = Date.now();
    const mk = (u5: number, u7: number) => mergeUsage(null, { fiveHour: { utilization: u5 }, sevenDay: { utilization: u7 } }, now);
    expect(quotaState(mk(0.1, 0.2), cfg, now)).toBe('ok');
    expect(quotaState(mk(0.1, 0.8), cfg, now)).toBe('soft');
    expect(quotaState(mk(0.95, 0.2), cfg, now)).toBe('hard');
    expect(quotaState(mk(0.99, 0.2), cfg, now)).toBe('stop');
    expect(quotaState(null, cfg)).toBe('unknown');
  });
  it('une fenêtre échue est remise à zéro', () => {
    expect(effectiveUtilization({ utilization: 0.95, resetsAt: 1 })).toBe(0);
    const now = Date.now();
    const old = mergeUsage(null, { sevenDay: { utilization: 0.95, resetsAt: Math.floor(now / 1000) - 10 } }, now);
    expect(quotaState(old, cfg, now)).toBe('ok');
  });
  it('un refus n’est valable que 30 min (évite de couper Claude à vie)', () => {
    const now = Date.now();
    const rejected = mergeUsage(null, { status: 'rejected', sevenDay: { utilization: 0.5 } }, now);
    expect(quotaState(rejected, cfg, now + 60_000)).toBe('stop');
    expect(quotaState(rejected, cfg, now + 31 * 60_000)).toBe('ok');
  });
});

describe('événements des backends', () => {
  it('Claude : texte, outil, résultat d’outil, quota, usage', () => {
    const out = [
      ...mapClaudeEvent({ type: 'system', subtype: 'init', session_id: 's1' }),
      ...mapClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } }),
      ...mapClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'total 0' }] }] } }),
      ...mapClaudeEvent({ type: 'result', usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 4 }, total_cost_usd: 0.02 }),
    ];
    expect(out.map((e) => e.type)).toEqual(['session', 'text', 'tool', 'tool_result', 'usage']);
    expect(out[2]).toMatchObject({ name: 'Bash', summary: 'ls -la' });
    expect(out[4]).toMatchObject({ inputTokens: 110, outputTokens: 4, costUsd: 0.02 });
  });
  it('Claude : erreur de limite → kind quota', () => {
    const out = [...mapClaudeEvent({ type: 'result', is_error: true, result: "You've hit your usage limit", usage: {} })];
    expect(out.find((e) => e.type === 'error')).toMatchObject({ kind: 'quota' });
  });
  it('OpenCode : session, texte, outil complété', () => {
    const seen = {};
    const out = [
      ...mapOpencodeEvent({ type: 'text', sessionID: 'ses_1', part: { text: 'hello' } }, seen),
      ...mapOpencodeEvent({ type: 'tool_use', part: { tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb', title: 'ls' } } }, seen),
      ...mapOpencodeEvent({ type: 'text', part: { text: '  ' } }, seen),
    ];
    expect(out.map((e) => e.type)).toEqual(['session', 'text', 'tool', 'tool_result']);
  });
  it('Gemini : init, texte delta, outil, usage', () => {
    const seen = {};
    const out = [
      ...mapGeminiEvent({ type: 'init', session_id: 'g1' }, seen),
      ...mapGeminiEvent({ type: 'message', role: 'user', content: 'demande' }, seen),
      ...mapGeminiEvent({ type: 'message', role: 'assistant', content: 'OK', delta: true }, seen),
      ...mapGeminiEvent({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: 'a.txt' } }, seen),
      ...mapGeminiEvent({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'contenu' }, seen),
      ...mapGeminiEvent({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 } }, seen),
    ];
    expect(out.map((e) => e.type)).toEqual(['session', 'text', 'tool', 'tool_result', 'usage']);
    expect(out[1]).toMatchObject({ delta: true });
    expect(out[2]).toMatchObject({ name: 'read_file', summary: 'a.txt' });
    expect(out[4]).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });
  it('Gemini : statut non réussi → erreur', () => {
    const out = [...mapGeminiEvent({ type: 'result', status: 'error', error: { message: 'quota exceeded' }, stats: {} }, {})];
    expect(out.find((e) => e.type === 'error')).toMatchObject({ kind: 'quota' });
  });
  it('Vibe : session, message assistant, effet outil', () => {
    const seen = {};
    const out = [
      ...mapVibeEntry({ type: 'message', role: 'user', session_id: 'v1', content: [{ type: 'text', text: 'demande' }] }, seen),
      ...mapVibeEntry({ type: 'message', role: 'assistant', session_id: 'v1', content: [{ type: 'text', text: 'voilà' }] }, seen),
      ...mapVibeEntry({ type: 'effect', id: 'e1', title: 'Bash', detail: { kind: 'shell' }, state: { status: 'completed', output_text: 'ok' } }, seen),
    ];
    expect(out.map((e) => e.type)).toEqual(['session', 'text', 'tool', 'tool_result']);
    expect(out[1]).toMatchObject({ text: 'voilà' });
    expect(out[2]).toMatchObject({ name: 'shell', summary: 'Bash' });
  });
});

describe('matériel', () => {
  it('vm_stat', () => {
    const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 1000.\nPages speculative: 0.\nPages purgeable: 0.';
    expect(parseVmStat(text)).toBeCloseTo((2000 * 16384) / 1024 ** 3, 4);
    expect(parseVmStat('rien')).toBeNull();
  });
  it('pmset', () => {
    expect(parsePmset("Now drawing from 'Battery Power'", ' lowpowermode 1\n')).toEqual({ onBattery: true, lowPowerMode: true });
    expect(parsePmset("Now drawing from 'AC Power'", ' lowpowermode 0')).toEqual({ onBattery: false, lowPowerMode: false });
  });
  it('classes mémoire', () => {
    expect([8, 16, 32, 96].map(classifyMemory)).toEqual(['small', 'medium', 'large', 'xl']);
  });
});

describe('config', () => {
  beforeAll(() => {
    process.env.CODEBREAK_HOME = tempHome();
  });
  it('fusion profonde', () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });
  it('écrit/valide une clé pointée, refuse une valeur invalide, surcharge projet', () => {
    setConfigValue('router.model', 'ministral-3:3b');
    setConfigValue('profile', 'eco');
    expect(() => setConfigValue('profile', 'nimporte')).toThrow();
    expect(loadConfig('/nonexistent').config.router.model).toBe('ministral-3:3b');
    const proj = tempHome();
    writeFileSync(join(proj, '.codebreak.yaml'), 'profile: quality\n');
    const l = loadConfig(proj);
    expect(l.config.profile).toBe('quality');
    expect(l.config.router.model).toBe('ministral-3:3b');
    expect(l.projectPath).toBeTruthy();
  });
});

describe('routeur LLM configurable', () => {
  it('auto : plus petit modèle Ollama', () => {
    expect(pickRouterModel(detection, cfg)).toMatchObject({ provider: 'ollama', model: 'ministral-3:8b' });
  });
  it('choix explicite et repli', () => {
    expect(pickRouterModel(detection, ConfigSchema.parse({ router: { provider: 'opencode' } }))).toMatchObject({
      provider: 'opencode',
      model: 'opencode/big-pickle',
    });
    expect(pickRouterModel(detection, ConfigSchema.parse({ router: { provider: 'claude' } }))).toMatchObject({ model: 'haiku' });
    expect(pickRouterModel(detection, ConfigSchema.parse({ router: { provider: 'rules' } }))).toBeNull();
    expect(pickRouterModel(detection, ConfigSchema.parse({ router: { mode: 'never' } }))).toBeNull();
    const noOllama = { ...detection, ollama: { ...detection.ollama, models: [] } };
    expect(pickRouterModel(noOllama, cfg)?.provider).toBe('opencode');
  });
  it('JSON du classifieur : valide, entouré de texte, invalide', () => {
    expect(parseLlmJson('```json\n{"complexity":3,"category":"backend","needs_edit":true,"security":false,"confidence":0.8,"reason":"x"}\n```')).toMatchObject({ complexity: 3, category: 'backend' });
    expect(parseLlmJson('{"complexity":9,"category":"x"}')).toBeNull();
    expect(parseLlmJson('pas de json')).toBeNull();
    expect(parseLlmJson('{"complexity":2,"category":"inconnue"}')?.category).toBeUndefined();
  });
});

describe('confidentialité', () => {
  it('détecte clés et mots de passe, pas les simples mentions de .env', () => {
    expect(containsSecret('utilise sk-ant-api03-abcdefghijklmnopqrstuvwxyz', cfg)).toBe(true);
    expect(containsSecret('password = hunter2hunter2', cfg)).toBe(true);
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----', cfg)).toBe(true);
    expect(containsSecret('ajoute la variable dans le fichier .env', cfg)).toBe(false);
  });
});

describe('vérification', () => {
  const proj = (scripts: Record<string, string>, lock?: string) => {
    const dir = tempHome();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    if (lock) writeFileSync(join(dir, lock), '');
    return dir;
  };
  it('détecte typecheck, lint, test (un par famille) et le gestionnaire de paquets', () => {
    expect(detectVerifyCommands(proj({ typecheck: 'tsc', lint: 'eslint .', test: 'vitest run', build: 'x' }, 'pnpm-lock.yaml'), cfg)).toEqual([
      'pnpm run -s typecheck', 'pnpm run -s lint', 'pnpm run -s test',
    ]);
  });
  it('ignore le test par défaut de npm et les scripts watch', () => {
    expect(detectVerifyCommands(proj({ test: 'echo "Error: no test specified" && exit 1' }), cfg)).toEqual([]);
    expect(detectVerifyCommands(proj({ test: 'vitest --watch' }), cfg)).toEqual([]);
  });
  it('commandes explicites et mode off', () => {
    const c = ConfigSchema.parse({ verify: { commands: ['make check'] } });
    expect(detectVerifyCommands(proj({ test: 'x' }), c)).toEqual(['make check']);
    expect(detectVerifyCommands(proj({ test: 'x' }), ConfigSchema.parse({ verify: { mode: 'off' } }))).toEqual([]);
    mkdirSync(tempHome(), { recursive: true });
  });
});

describe('journal et apprentissage', () => {
  const e = (over: Partial<LedgerEntry>): LedgerEntry => ({
    ts: 1, task: 'a', target: 'ollama:x', backend: 'ollama', category: 'frontend', complexity: 2, ok: true,
    inputTokens: 1000, outputTokens: 100, costUsd: 0, durationMs: 1000, verify: 'pass', ...over,
  });
  it('résumé : réussite, escalades, économie estimée (hors Claude)', () => {
    const s = summarize([e({}), e({ task: 'b', ok: false, verify: 'fail' }), e({ task: 'b', target: 'claude:sonnet', backend: 'claude', escalatedFrom: 'ollama:x' })]);
    expect(s.tasks).toBe(2);
    expect(s.runs).toBe(3);
    expect(s.escalationRate).toBeCloseTo(1 / 3);
    expect(s.savedUsdEstimate).toBeCloseTo(1000 * (3 / 1e6) + 100 * (15 / 1e6));
  });
  it('taux d’échec récent par cible et catégorie', () => {
    const list = [e({ ok: false }), e({ ok: false }), e({ ok: true }), e({ ok: false }), e({ category: 'backend', ok: false })];
    expect(recentFailureRate(list, 'ollama:x', 'frontend')).toEqual({ rate: 0.75, samples: 4 });
    expect(recentFailureRate(list, 'ollama:x', 'media')).toEqual({ rate: 0, samples: 0 });
  });
  it('usage agrégé par backend (toutes les IA, pas seulement par modèle précis)', () => {
    const byBackend = usageByBackend([
      e({}),
      e({ target: 'ollama:y', inputTokens: 500, outputTokens: 50 }),
      e({ backend: 'claude', target: 'claude:sonnet', ok: false, ts: 5 }),
    ]);
    expect(byBackend.get('ollama')).toMatchObject({ runs: 2, ok: 2, inputTokens: 1500, outputTokens: 150 });
    expect(byBackend.get('claude')).toMatchObject({ runs: 1, ok: 0 });
    expect(byBackend.has('gemini')).toBe(false);
  });
});

describe('exemple de configuration', () => {
  it('examples/config.yaml est valide et équivaut aux valeurs par défaut (sauf profiles)', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const raw = parse(readFileSync(new URL('../examples/config.yaml', import.meta.url), 'utf8'));
    const parsed = ConfigSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.quota.claude.hard).toBe(0.9);
    expect(parsed.success && parsed.data.router.mode).toBe('ambiguous');
  });
});

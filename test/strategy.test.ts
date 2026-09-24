import { describe, expect, it } from 'vitest';
import type { Diagnosis, FailureKind } from '../src/exec/diagnose.js';
import { decideNext, describeReason, type AttemptSummary, type StrategyInput } from '../src/exec/strategy.js';
import { targetsOf } from './helpers.js';

const T = targetsOf();
const local = T['ollama:ministral-3:8b']!;
const free = T['opencode:opencode/big-pickle']!;
const sonnet = T['claude:sonnet']!;
const opus = T['claude:opus']!;

const diag = (kind: FailureKind, over: Partial<Diagnosis> = {}): Diagnosis => ({ kind, summary: `${kind} failure`, fingerprint: `fp-${kind}`, files: [], confidence: 'high', ...over });
const attempt = (n: number, target = local, d: Diagnosis = diag('typecheck')): AttemptSummary => ({ n, target, ok: false, changed: 1, diagnosis: d });

const base = (attempts: AttemptSummary[], over: Partial<StrategyInput> = {}): StrategyInput => ({
  attempts,
  chain: [local, free, sonnet, opus],
  cfg: { enabled: true, max_attempts: 6, same_agent_retries: 1, max_minutes: 0, max_cost_usd: 0 },
  elapsedMs: 0,
  costUsd: 0,
  ...over,
});

describe('stratégie retry / escalade / arrêt', () => {
  it('erreur simple → nouvelle tentative avec le MÊME agent (pas d’escalade systématique)', () => {
    for (const kind of ['syntax', 'typecheck', 'lint', 'compile'] as const) {
      const n = decideNext(base([attempt(1, local, diag(kind))]));
      expect(n, kind).toMatchObject({ action: 'retry', target: { id: local.id }, reason: { code: 'simple_error' } });
    }
  });

  it('échec de tests : retry seulement s’il est petit et identifié', () => {
    expect(decideNext(base([attempt(1, local, diag('test', { errorCount: 2 }))]))).toMatchObject({ action: 'retry' });
    expect(decideNext(base([attempt(1, local, diag('test', { errorCount: 12 }))]))).toMatchObject({ action: 'escalate' });
    expect(decideNext(base([attempt(1, local, diag('test'))]))).toMatchObject({ action: 'escalate' });
  });

  it('les reprises du même agent sont bornées, puis escalade', () => {
    const a1 = attempt(1, local, diag('typecheck', { fingerprint: 'A' }));
    const a2 = attempt(2, local, diag('typecheck', { fingerprint: 'B' }));
    expect(decideNext(base([a1, a2]))).toMatchObject({ action: 'escalate', target: { id: free.id } });
    expect(decideNext(base([a1, a2], { cfg: { ...base([]).cfg, same_agent_retries: 2 } }))).toMatchObject({ action: 'retry' });
    expect(decideNext(base([a1], { cfg: { ...base([]).cfg, same_agent_retries: 0 } }))).toMatchObject({ action: 'escalate' });
  });

  it('même échec qu’avant → ne recommence pas à l’identique : agent PLUS FORT', () => {
    const same = diag('typecheck', { fingerprint: 'SAME' });
    const n = decideNext(base([attempt(1, local, same), attempt(2, local, same)]));
    expect(n).toMatchObject({ action: 'escalate', reason: { code: 'repeated_failure' } });
    expect((n as { target: { level: number } }).target.level).toBeGreaterThan(local.level);
    // sans agent plus fort disponible : on s'arrête plutôt que de tourner en rond
    const stuck = decideNext(base([attempt(1, opus, same), attempt(2, opus, same)], { chain: [opus] }));
    expect(stuck).toMatchObject({ action: 'stop', reason: { code: 'no_progress' } });
  });

  it('un échec identique répété par un autre agent compte aussi', () => {
    const same = diag('test', { fingerprint: 'SAME', errorCount: 1 });
    expect(decideNext(base([attempt(1, local, same), attempt(2, free, same)]))).toMatchObject({ reason: { code: 'repeated_failure' } });
  });

  it('environnement → arrêt immédiat, aucun agent ne peut le corriger', () => {
    expect(decideNext(base([attempt(1, local, diag('environment', { summary: 'EADDRINUSE' }))]))).toMatchObject({ action: 'stop', reason: { code: 'environment' } });
  });

  it('structurel ou manque de contexte → agent plus capable', () => {
    for (const kind of ['architecture', 'missing_context'] as const) {
      const n = decideNext(base([attempt(1, local, diag(kind))]));
      expect(n.action).toBe('escalate');
      expect((n as { target: { level: number } }).target.level).toBeGreaterThan(local.level);
    }
  });

  it('agent indisponible (quota/auth) → autre backend, plantage → suivant', () => {
    const quota = diag('agent', { summary: 'quota: limit reached' });
    const n = decideNext(base([attempt(1, sonnet, quota)], { chain: [sonnet, opus, free] }));
    expect(n).toMatchObject({ action: 'escalate', target: { id: free.id }, reason: { code: 'agent_unavailable' } });
    const crash = diag('agent', { summary: 'crash: boom' });
    expect(decideNext(base([attempt(1, local, crash)]))).toMatchObject({ action: 'escalate', target: { id: free.id }, reason: { code: 'agent_crash' } });
  });

  it('absence de modification → escalade', () => {
    expect(decideNext(base([attempt(1, local, diag('no_change'))]))).toMatchObject({ action: 'escalate', reason: { code: 'no_change' } });
  });

  it('délai dépassé : une reprise pour écarter une boucle infinie, puis escalade', () => {
    expect(decideNext(base([attempt(1, local, diag('timeout', { fingerprint: 'T1' }))]))).toMatchObject({ action: 'retry', reason: { code: 'timeout_retry' } });
    expect(decideNext(base([attempt(1, local, diag('timeout', { fingerprint: 'T1' })), attempt(2, local, diag('timeout', { fingerprint: 'T2' }))]))).toMatchObject({ action: 'escalate' });
  });

  it('budgets : tentatives, temps, coût', () => {
    expect(decideNext(base([attempt(1), attempt(2, free), attempt(3, sonnet)], { cfg: { ...base([]).cfg, max_attempts: 3 } }))).toMatchObject({ action: 'stop', reason: { code: 'attempts_exhausted' } });
    expect(decideNext(base([attempt(1)], { cfg: { ...base([]).cfg, max_minutes: 5 }, elapsedMs: 6 * 60_000 }))).toMatchObject({ action: 'stop', reason: { code: 'time_budget' } });
    expect(decideNext(base([attempt(1)], { cfg: { ...base([]).cfg, max_cost_usd: 1 }, costUsd: 1.5 }))).toMatchObject({ action: 'stop', reason: { code: 'cost_budget' } });
    expect(decideNext(base([attempt(1)], { cfg: { ...base([]).cfg, enabled: false } }))).toMatchObject({ action: 'stop', reason: { code: 'escalation_disabled' } });
  });

  it('respecte la disponibilité (quota, authentification) et les backends déjà en échec', () => {
    const n = decideNext(base([attempt(1, local, diag('architecture'))], { available: (t) => ({ ok: t.backend !== 'claude' }) }));
    expect(n).toMatchObject({ action: 'escalate', target: { id: free.id } });
    const none = decideNext(base([attempt(1, local, diag('architecture'))], { chain: [local, sonnet], available: () => ({ ok: false }) }));
    expect(none).toMatchObject({ action: 'stop', reason: { code: 'no_target' } });
    const skip = decideNext(base([attempt(1, local, diag('unknown'))], { chain: [local, sonnet, free], unavailable: new Set(['claude']) }));
    expect(skip).toMatchObject({ target: { id: free.id } });
  });

  it('chaque décision a une raison lisible', () => {
    const n = decideNext(base([attempt(1, local, diag('typecheck'))]));
    expect(describeReason(n.reason, (k, v) => k.replace(/\{(\w+)\}/g, (_m, name) => String(v?.[name])))).toMatch(/simple \(typecheck\)/);
  });
});

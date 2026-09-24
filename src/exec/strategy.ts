import type { BackendId, Target } from '../types.js';
import { SIMPLE_KINDS, type Diagnosis } from './diagnose.js';

/**
 * Après un échec : réessayer avec le même agent, escalader, ou s'arrêter ? La règle n'est PAS « toujours changer
 * d'agent » : une erreur simple se corrige sur place ; une erreur qui se répète, ou structurelle, appelle un agent
 * plus fort ; un problème d'environnement n'est corrigible par aucun agent.
 */

export interface AttemptSummary {
  n: number;
  target: Target;
  ok: boolean;
  /** fichiers modifiés par cette tentative */
  changed: number;
  diagnosis?: Diagnosis;
}

export type ReasonCode =
  | 'simple_error'
  | 'repeated_failure'
  | 'structural'
  | 'missing_context'
  | 'agent_unavailable'
  | 'agent_crash'
  | 'no_change'
  | 'timeout_retry'
  | 'unknown_escalate'
  | 'environment'
  | 'attempts_exhausted'
  | 'time_budget'
  | 'cost_budget'
  | 'no_target'
  | 'no_progress'
  | 'escalation_disabled';

export interface Reason {
  code: ReasonCode;
  params?: Record<string, unknown>;
}

export type Next =
  | { action: 'retry'; target: Target; reason: Reason }
  | { action: 'escalate'; target: Target; reason: Reason }
  | { action: 'stop'; reason: Reason };

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface StrategyInput {
  /** tentatives déjà faites, la dernière étant celle qui vient d'échouer */
  attempts: AttemptSummary[];
  /** échelle d'escalade prévue (ordre de préférence) */
  chain: Target[];
  cfg: { enabled: boolean; max_attempts: number; same_agent_retries: number; max_minutes: number; max_cost_usd: number };
  elapsedMs: number;
  costUsd: number;
  /** disponibilité d'une cible (quota, authentification…) ; par défaut tout est disponible */
  available?: (t: Target) => Availability;
  /** backends déjà constatés indisponibles pendant cette tâche */
  unavailable?: ReadonlySet<BackendId>;
}

/** Textes (clés françaises) associés à chaque code ; traduits par `t()` à l'affichage. */
export const REASONS: Record<ReasonCode, string> = {
  simple_error: 'erreur simple ({kind}) : nouvelle tentative avec le même agent',
  repeated_failure: 'même échec qu’avant : changer d’approche plutôt que recommencer à l’identique',
  structural: 'problème structurel ({kind}) : agent plus capable',
  missing_context: 'l’agent semble manquer de contexte : agent plus capable',
  agent_unavailable: '{label} indisponible ({detail})',
  agent_crash: '{label} a échoué ({detail})',
  no_change: 'aucune modification détectée alors qu’une modification était attendue',
  timeout_retry: 'délai dépassé : nouvelle tentative pour vérifier que ce n’est pas une boucle infinie',
  unknown_escalate: 'échec non identifié : agent plus capable',
  environment: 'problème d’environnement ({summary}) : aucun agent ne peut le corriger, à résoudre à la main',
  attempts_exhausted: 'nombre maximal de tentatives atteint ({max})',
  time_budget: 'budget de temps dépassé ({minutes} min)',
  cost_budget: 'budget de coût dépassé ({cost} $)',
  no_target: 'aucun agent disponible pour continuer',
  no_progress: 'le même échec persiste et aucun agent plus fort n’est disponible',
  escalation_disabled: 'escalade désactivée',
};

export function describeReason(r: Reason, tf: (key: string, vars?: Record<string, unknown>) => string): string {
  return tf(REASONS[r.code], r.params);
}

const backendOf = (t: Target) => t.backend;

/** Premier candidat de l'échelle après `from` (ou plus fort que lui) et disponible ; `skipped` explique les écartés. */
function nextAvailable(input: StrategyInput, from: Target, opts: { stronger?: boolean; differentBackend?: boolean }): Target | undefined {
  const idx = input.chain.findIndex((t) => t.id === from.id);
  const usedIds = new Set(input.attempts.map((a) => a.target.id));
  const candidates = input.chain.filter((t, i) => i > idx && t.id !== from.id);
  for (const t of candidates) {
    if (input.unavailable?.has(t.backend)) continue;
    if (input.available && !input.available(t).ok) continue;
    if (opts.differentBackend && backendOf(t) === backendOf(from)) continue;
    if (opts.stronger && !(t.level > from.level || (t.level === from.level && t.power > from.power))) continue;
    // une cible déjà essayée sans succès n'est reprise que par la règle « nouvelle tentative », pas par escalade
    if (usedIds.has(t.id)) continue;
    return t;
  }
  return undefined;
}

export function decideNext(input: StrategyInput): Next {
  const last = input.attempts.at(-1)!;
  const d = last.diagnosis!;
  const { cfg } = input;
  const stop = (code: ReasonCode, params?: Record<string, unknown>): Next => ({ action: 'stop', reason: { code, params } });

  if (!cfg.enabled) return stop('escalation_disabled');
  if (input.attempts.length >= cfg.max_attempts) return stop('attempts_exhausted', { max: cfg.max_attempts });
  if (cfg.max_minutes > 0 && input.elapsedMs > cfg.max_minutes * 60_000) return stop('time_budget', { minutes: cfg.max_minutes });
  if (cfg.max_cost_usd > 0 && input.costUsd > cfg.max_cost_usd) return stop('cost_budget', { cost: cfg.max_cost_usd });

  // un problème d'environnement n'est corrigible par aucun agent : ne pas brûler de quota
  if (d.kind === 'environment') return stop('environment', { summary: d.summary });

  const escalate = (code: ReasonCode, params?: Record<string, unknown>, opts: { stronger?: boolean; differentBackend?: boolean } = {}): Next => {
    const target = nextAvailable(input, last.target, opts);
    if (target) return { action: 'escalate', target, reason: { code, params } };
    // pas de cible plus forte : à défaut, n'importe quelle cible restante non essayée
    const any = opts.stronger ? nextAvailable(input, last.target, { differentBackend: opts.differentBackend }) : undefined;
    if (any && code !== 'repeated_failure') return { action: 'escalate', target: any, reason: { code, params } };
    return stop(code === 'repeated_failure' ? 'no_progress' : 'no_target');
  };

  // l'agent lui-même est en cause : quota, authentification, indisponibilité, plantage
  if (d.kind === 'agent') {
    const kind = d.summary.split(':')[0];
    if (kind === 'quota' || kind === 'auth' || kind === 'unavailable') {
      return escalate('agent_unavailable', { label: last.target.label, detail: d.summary.replace(/^[^:]+:\s*/, '') }, { differentBackend: true });
    }
    return escalate('agent_crash', { label: last.target.label, detail: d.summary.replace(/^[^:]+:\s*/, '') });
  }
  if (d.kind === 'no_change') return escalate('no_change');

  // même échec qu'avant (avec ce ou un autre agent) : recommencer à l'identique ne sert à rien
  const seenBefore = input.attempts.slice(0, -1).some((a) => a.diagnosis?.fingerprint === d.fingerprint);
  if (seenBefore) return escalate('repeated_failure', undefined, { stronger: true });

  if (d.kind === 'timeout') {
    const retried = input.attempts.filter((a) => a.target.id === last.target.id).length - 1;
    if (retried < 1 && cfg.same_agent_retries > 0) return { action: 'retry', target: last.target, reason: { code: 'timeout_retry' } };
    return escalate('unknown_escalate');
  }

  // erreur simple et identifiée : le même agent la corrige sur place (nombre de reprises borné)
  const sameRun = (() => {
    let n = 0;
    for (let i = input.attempts.length - 1; i >= 0 && input.attempts[i]!.target.id === last.target.id; i--) n++;
    return n - 1; // reprises déjà faites avec cet agent
  })();
  const simple = SIMPLE_KINDS.has(d.kind) && (d.kind !== 'test' || (d.errorCount !== undefined && d.errorCount <= 3));
  if (simple && sameRun < cfg.same_agent_retries) {
    return { action: 'retry', target: last.target, reason: { code: 'simple_error', params: { kind: d.kind } } };
  }

  if (d.kind === 'missing_context') return escalate('missing_context', undefined, { stronger: true });
  if (d.kind === 'architecture') return escalate('structural', { kind: d.kind }, { stronger: true });
  if (SIMPLE_KINDS.has(d.kind)) return escalate('structural', { kind: d.kind });
  return escalate('unknown_escalate');
}

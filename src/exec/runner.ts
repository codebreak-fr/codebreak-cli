import { randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import { runTarget, type RunRequest } from '../backends/index.js';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import { t, translateTo } from '../i18n/index.js';
import { memoryPaths } from '../memory/layout.js';
import type { TaskRecorder } from '../memory/recorder.js';
import type { BackendId, Decision, RunEvent, Target } from '../types.js';
import { record } from '../usage/ledger.js';
import { noteAgentError } from '../usage/monitor.js';
import { redact } from '../util/redact.js';
import { diagnoseAgentError, diagnoseNoChange, diagnoseVerify, type Diagnosis } from './diagnose.js';
import { changedFiles, snapshot } from './git.js';
import { changesBetween, createWorkSnapshot, pruneSnapshots, rollbackAttempt, type WorkSnapshot } from './snapshots.js';
import { decideNext, describeReason, type Availability, type AttemptSummary, type Reason } from './strategy.js';
import { detectVerifyCommands, runVerify, type VerifyResult } from './verify.js';

export type TaskEvent =
  | { type: 'attempt'; n: number; total: number; target: Target }
  | { type: 'run'; target: Target; event: RunEvent }
  | { type: 'verify_start'; commands: string[] }
  | { type: 'verify_result'; result: VerifyResult }
  | { type: 'diagnosis'; attempt: number; diagnosis: Diagnosis }
  | { type: 'retry'; attempt: number; target: Target; reason: string }
  | { type: 'rollback'; attempt: number; restored: string[]; removed: string[]; skipped: number }
  | { type: 'escalate'; from: Target; to: Target; reason: string }
  | { type: 'done'; ok: boolean; target: Target | null; text: string; handoff: boolean; verified?: boolean; message?: string; filesChanged?: string[]; taskId?: string };

export interface TaskOptions {
  prompt: string;
  decision: Decision;
  cwd: string;
  cfg: Config;
  det: Detection;
  signal: AbortSignal;
  /** sessions reprenables par backend */
  sessions?: Partial<Record<BackendId, string>>;
  /** résumé de la conversation, en clair, pour les cibles sans accès au dépôt (pas d'outil pour lire un fichier) */
  recap?: string;
  /**
   * Référence courte vers le fichier de contexte partagé (.md), pour les cibles qui ont accès au dépôt :
   * quelques dizaines de tokens au lieu de réinjecter tout l'historique à chaque changement d'outil.
   */
  recapFile?: string;
  /** contexte projet sélectionné par le Context Builder (`.codebreak/`) : préfixe borné du prompt de chaque nouvel agent */
  contextText?: string;
  /** mémoire Markdown de la tâche (manifeste, chronologie, échecs) ; absent = rien n'est écrit */
  recorder?: TaskRecorder | null;
  /** disponibilité d'une cible (quota, authentification…), fournie par le moniteur d'usage / l'ordonnanceur */
  available?: (t: Target) => Availability;
  taskId?: string;
  /** exécuteur de backend (injectable pour les tests) */
  runner?: (req: RunRequest) => AsyncGenerator<RunEvent>;
}

const tail = (s: string, n = 2500) => (s.length > n ? '…' + s.slice(-n) : s);

function retryPrompt(original: string, prev: Target, reason: string, files: string[], output?: string): string {
  return [
    original,
    '',
    '---',
    t('Contexte d’escalade : une tentative précédente avec {label} n’a pas abouti.', { label: prev.label }),
    t('Motif : {reason}', { reason }),
    files.length ? t('Fichiers modifiés par la tentative : {v}', { v: files.slice(0, 20).join(', ') }) : '',
    output ? t('Sortie des vérifications (extrait) :\n```\n{output}\n```', { output: redact(output) }) : '',
    t('Reprends depuis l’état actuel du dépôt : corrige ce qui échoue sans tout réécrire.'),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Nouvelle tentative du MÊME agent après une erreur simple : on lui donne le diagnostic et la sortie utile. */
function sameAgentPrompt(original: string, d: Diagnosis, files: string[], output?: string): string {
  return [
    original,
    '',
    '---',
    t('Nouvelle tentative : ton travail précédent ne passe pas encore la vérification.'),
    t('Diagnostic : {summary}', { summary: d.summary }),
    files.length ? t('Fichiers modifiés par la tentative : {v}', { v: files.slice(0, 20).join(', ') }) : '',
    output ? t('Sortie des vérifications (extrait) :\n```\n{output}\n```', { output: redact(output) }) : '',
    t('Corrige uniquement ce qui échoue, sans tout réécrire ni changer d’approche.'),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function* runTask(opts: TaskOptions): AsyncGenerator<TaskEvent> {
  const { decision, cwd, cfg, det, signal } = opts;
  const chain = decision.chain;
  const taskId = opts.taskId ?? randomUUID().slice(0, 8);
  const rec = opts.recorder ?? null;
  if (chain.length === 0) {
    rec?.finish('failed', 'no target available');
    yield { type: 'done', ok: false, target: null, text: '', handoff: false, message: t('Aucune cible disponible.'), taskId };
    return;
  }

  // la mémoire de CodeBreak n'est jamais comptée comme travail de l'agent
  const memRel = (() => {
    if (!cfg.memory.enabled) return [];
    const dir = memoryPaths(cwd, cfg).dir;
    const rel = isAbsolute(cfg.memory.dir) ? relative(cwd, dir) : cfg.memory.dir;
    return rel.startsWith('..') ? [] : [rel.replace(/\/$/, '')];
  })();
  void pruneSnapshots(cwd).catch(() => 0);

  const maxAttempts = cfg.escalation.enabled ? cfg.escalation.max_attempts : 1;
  const attempts: AttemptSummary[] = [];
  const unavailable = new Set<BackendId>();
  const runSessions: Partial<Record<BackendId, string>> = {};
  const startedAt = Date.now();
  let costTotal = 0;
  let lastText = '';
  let target: Target = chain[0]!;
  let prompt = opts.prompt;
  let mode: 'first' | 'retry' | 'escalate' = 'first';
  let prev: Target | undefined;

  const finish = (status: 'done' | 'failed' | 'aborted' | 'handoff', message?: string) => rec?.finish(status, message);

  while (true) {
    const n = attempts.length + 1;
    yield { type: 'attempt', n, total: Math.max(maxAttempts, 1), target };

    const sessionId = mode === 'first' ? opts.sessions?.[target.backend] : mode === 'retry' ? runSessions[target.backend] : undefined;
    // les cibles qui peuvent lire le dépôt reçoivent une référence courte vers le fichier de contexte
    // partagé plutôt que l'historique en clair : ça évite de repayer les mêmes tokens à chaque tour.
    const recapText = target.caps.tools && opts.recapFile ? opts.recapFile : opts.recap;
    const needsRecap = mode === 'first' && !sessionId && recapText;
    // un agent qui reprend sa session connaît déjà le contexte ; un nouvel agent le reçoit une fois
    const ctx = opts.contextText && !sessionId ? `${opts.contextText}\n\n` : '';
    const effective = ctx + (needsRecap ? `${recapText}\n\n${prompt}` : prompt);

    const pre = await createWorkSnapshot(cwd, `${taskId}-a${n}-pre`, { exclude: memRel }).catch(() => null);
    const legacyBefore = pre ? null : await snapshot(cwd);
    rec?.attemptStarted(n, target, pre?.id);

    const started = Date.now();
    let text = '';
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    let error: Extract<RunEvent, { type: 'error' }> | undefined;
    let handoff = false;

    const timeoutMs = cfg.escalation.attempt_timeout_minutes * 60_000;
    const attemptSignal = timeoutMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal;

    try {
      for await (const event of (opts.runner ?? runTarget)({ prompt: effective, cwd, target, signal: attemptSignal, sessionId, cfg, det, needsTools: decision.features.needsRepo })) {
        if (event.type === 'text') text += event.delta || !text ? event.text : '\n' + event.text;
        if (event.type === 'usage') {
          inTok += event.inputTokens;
          outTok += event.outputTokens;
          cost += event.costUsd ?? 0;
        }
        if (event.type === 'session') runSessions[target.backend] = event.id;
        if (event.type === 'error') error = event;
        if (event.type === 'handoff') handoff = true;
        yield { type: 'run', target, event };
      }
    } catch (e) {
      // une interruption n'est pas une erreur ; toute autre exception d'adaptateur devient une erreur escaladable
      if (!signal.aborted) {
        error = { type: 'error', kind: 'crash', message: (e as Error).message };
        yield { type: 'run', target, event: error };
      }
    }
    // délai maximal de la tentative dépassé (et non une interruption de l'utilisateur)
    // (l'exception d'abandon levée par l'adaptateur n'est alors que la conséquence du délai)
    if (!signal.aborted && attemptSignal.aborted && timeoutMs > 0) {
      error = { type: 'error', kind: 'crash', message: t('délai maximal de la tentative dépassé ({minutes} min)', { minutes: cfg.escalation.attempt_timeout_minutes }) };
      yield { type: 'run', target, event: error };
    }
    lastText = text || lastText;
    costTotal += cost;
    const durationMs = Date.now() - started;

    const log = (ok: boolean, verify: 'pass' | 'fail' | 'skipped') =>
      record({
        ts: Date.now(),
        task: taskId,
        target: target.id,
        backend: target.backend,
        category: decision.features.category,
        complexity: decision.features.complexity,
        ok,
        escalatedFrom: prev?.id,
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: cost,
        durationMs,
        routerMs: n === 1 ? decision.classifierMs : undefined,
        verify,
        prompt: cfg.logging.content ? opts.prompt.slice(0, 500) : undefined,
      });

    if (signal.aborted) {
      log(false, 'skipped');
      rec?.attemptFinished(n, { ok: false, filesChanged: [], durationMs, tokens: inTok + outTok, costUsd: cost });
      finish('aborted', 'interrupted');
      yield { type: 'done', ok: false, target, text, handoff: false, message: 'Interrompu.', taskId };
      return;
    }

    // --- ce que CETTE tentative a changé (jamais le travail que l'utilisateur avait déjà en cours)
    const post: WorkSnapshot | null = pre ? await createWorkSnapshot(cwd, `${taskId}-a${n}-post`, { exclude: memRel }).catch(() => null) : null;
    let changed: string[];
    let isRepo: boolean;
    if (pre && post) {
      changed = (await changesBetween(cwd, pre, post)).map((c) => c.path);
      isRepo = true;
    } else {
      const after = await snapshot(cwd);
      isRepo = Boolean(pre) || Boolean(legacyBefore?.isRepo) || after.isRepo;
      changed = legacyBefore ? changedFiles(legacyBefore, after) : [];
    }

    const summary: AttemptSummary = { n, target, ok: false, changed: changed.length };
    const finishAttempt = (ok: boolean, extra: Parameters<NonNullable<typeof rec>['attemptFinished']>[1] = {}) =>
      rec?.attemptFinished(n, { ok, filesChanged: changed, snapshotAfter: post?.id, durationMs, tokens: inTok + outTok, costUsd: cost, ...extra });

    if (!error && (handoff || target.terminal)) {
      log(true, 'skipped');
      finishAttempt(true);
      finish('handoff');
      yield { type: 'done', ok: true, target, text, handoff: true, filesChanged: changed, taskId };
      return;
    }

    let diagnosis: Diagnosis | undefined;
    let failedOutput: string | undefined;
    let failedCommand: string | undefined;

    if (error) {
      log(false, 'skipped');
      diagnosis = diagnoseAgentError(error);
      if (error.kind === 'quota' || error.kind === 'auth' || error.kind === 'unavailable') unavailable.add(target.backend);
      // limite réellement constatée : gardée pour les décisions suivantes et affichée dans le moniteur d'usage
      const incident = noteAgentError(target.backend, error);
      if (incident) rec?.event('usage', `${target.label}: ${incident.kind}${incident.resetAt ? ` (reset ${new Date(incident.resetAt).toISOString()}, estimated)` : ' (reset unknown)'}`, { service: target.backend, kind: incident.kind });
    } else if (isRepo && decision.features.needsEdit && changed.length === 0 && target.level <= 1) {
      // un modèle gratuit qui « annonce » une modification sans toucher un fichier n'a rien fait
      log(false, 'fail');
      diagnosis = diagnoseNoChange();
    } else {
      // --- vérification par les signaux réels (typecheck / lint / tests) plutôt que par la parole du modèle
      const commands = isRepo && changed.length ? detectVerifyCommands(cwd, cfg) : [];
      if (commands.length === 0) {
        log(true, 'skipped');
        finishAttempt(true);
        finish('done');
        yield { type: 'done', ok: true, target, text, handoff: false, verified: false, filesChanged: changed, taskId };
        return;
      }
      rec?.verifying();
      yield { type: 'verify_start', commands };
      const result = await runVerify(cwd, commands, cfg, signal);
      yield { type: 'verify_result', result };
      rec?.verify(n, result.steps.map((s) => ({ command: s.command, ok: s.ok, exitCode: s.exitCode, ms: s.ms, timedOut: s.timedOut })));
      if (result.ok) {
        log(true, 'pass');
        finishAttempt(true);
        finish('done');
        yield { type: 'done', ok: true, target, text, handoff: false, verified: true, filesChanged: changed, taskId };
        return;
      }
      log(false, 'fail');
      const failed = result.steps.find((s) => !s.ok)!;
      failedCommand = failed.command;
      failedOutput = failed.output;
      diagnosis = diagnoseVerify(failed, cwd);
    }

    summary.diagnosis = diagnosis;
    attempts.push(summary);
    yield { type: 'diagnosis', attempt: n, diagnosis };
    rec?.failure(n, { kind: diagnosis.kind, fingerprint: diagnosis.fingerprint, summary: diagnosis.summary, command: failedCommand }, { files: diagnosis.files.length ? diagnosis.files : changed, output: failedOutput });
    finishAttempt(false);

    // --- retry, escalade ou arrêt ?
    const next = decideNext({
      attempts,
      chain,
      cfg: { enabled: cfg.escalation.enabled, max_attempts: maxAttempts, same_agent_retries: cfg.escalation.same_agent_retries, max_minutes: cfg.escalation.max_minutes, max_cost_usd: cfg.escalation.max_cost_usd },
      elapsedMs: Date.now() - startedAt,
      costUsd: costTotal,
      available: opts.available,
      unavailable,
    });
    const reasonText = (r: Reason) => describeReason(r, t);
    rec?.decision(n, { action: next.action, reason: describeReason(next.reason, (k, v) => translateEn(k, v)), to: next.action === 'stop' ? undefined : next.target.id });

    if (next.action === 'stop') {
      rec?.finish('failed', describeReason(next.reason, (k, v) => translateEn(k, v)));
      // messages historiques conservés pour les cas d'agent / vérification ; raisons explicites pour les autres
      const legacy = error && ['attempts_exhausted', 'no_target', 'escalation_disabled'].includes(next.reason.code)
        ? error.message
        : failedCommand && ['attempts_exhausted', 'no_target', 'escalation_disabled'].includes(next.reason.code)
          ? t('Vérification échouée : {command}', { command: failedCommand })
          : reasonText(next.reason);
      yield { type: 'done', ok: false, target, text, handoff: false, verified: failedCommand ? false : undefined, message: legacy, taskId };
      return;
    }

    // annulation éventuelle du travail de la tentative ratée avant la suivante
    const repeated = attempts.slice(0, -1).some((a) => a.diagnosis?.fingerprint === diagnosis!.fingerprint);
    const doRollback = pre && post && changed.length > 0 && (cfg.escalation.rollback === 'always' || (cfg.escalation.rollback === 'on_no_progress' && repeated));
    let carried = changed;
    if (doRollback) {
      const r = await rollbackAttempt(cwd, pre!, post!);
      rec?.event('rollback', `Rolled back attempt ${n}: ${r.restored.length} restored, ${r.removed.length} removed, ${r.skipped.length} skipped`, { n });
      yield { type: 'rollback', attempt: n, restored: r.restored, removed: r.removed, skipped: r.skipped.length };
      carried = r.skipped.map((s) => s.path);
    }

    if (next.action === 'retry') {
      yield { type: 'retry', attempt: n, target: next.target, reason: reasonText(next.reason) };
      prompt = sameAgentPrompt(opts.prompt, diagnosis, carried, failedOutput && tail(failedOutput));
      mode = 'retry';
    } else {
      const reason = error ? error.message : failedCommand ? t('échec de « {command} »', { command: failedCommand }) : t('aucune modification détectée alors qu’une modification était attendue');
      yield { type: 'escalate', from: target, to: next.target, reason };
      prompt = retryPrompt(opts.prompt, target, error ? error.message : failedCommand ? t('échec de la commande « {command} »', { command: failedCommand }) : reason, carried, failedOutput && tail(failedOutput));
      mode = 'escalate';
    }
    prev = target;
    target = next.target;
  }
}

/** Texte anglais d'une raison (fichiers Markdown : indépendants de la langue de l'interface). */
const translateEn = (k: string, v?: Record<string, unknown>) => translateTo('en', k, v);

import { randomUUID } from 'node:crypto';
import { runTarget, type RunRequest } from '../backends/index.js';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { BackendId, Decision, RunEvent, Target } from '../types.js';
import { record } from '../usage/ledger.js';
import { changedFiles, snapshot } from './git.js';
import { detectVerifyCommands, runVerify, type VerifyResult } from './verify.js';
import { t } from '../i18n/index.js';

export type TaskEvent =
  | { type: 'attempt'; n: number; total: number; target: Target }
  | { type: 'run'; target: Target; event: RunEvent }
  | { type: 'verify_start'; commands: string[] }
  | { type: 'verify_result'; result: VerifyResult }
  | { type: 'escalate'; from: Target; to: Target; reason: string }
  | { type: 'done'; ok: boolean; target: Target | null; text: string; handoff: boolean; verified?: boolean; message?: string; filesChanged?: string[] };

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
  /** exécuteur de backend (injectable pour les tests) */
  runner?: (req: RunRequest) => AsyncGenerator<RunEvent>;
}

function retryPrompt(original: string, prev: Target, reason: string, files: string[], output?: string): string {
  return [
    original,
    '',
    '---',
    t('Contexte d’escalade : une tentative précédente avec {label} n’a pas abouti.', { label: prev.label }),
    t('Motif : {reason}', { reason }),
    files.length ? t('Fichiers modifiés par la tentative : {v}', { v: files.slice(0, 20).join(', ') }) : '',
    output ? t('Sortie des vérifications (extrait) :\n```\n{output}\n```', { output }) : '',
    t('Reprends depuis l’état actuel du dépôt : corrige ce qui échoue sans tout réécrire.'),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function* runTask(opts: TaskOptions): AsyncGenerator<TaskEvent> {
  const { decision, cwd, cfg, det, signal } = opts;
  const chain = decision.chain;
  const taskId = randomUUID().slice(0, 8);
  if (chain.length === 0) {
    yield { type: 'done', ok: false, target: null, text: '', handoff: false, message: t('Aucune cible disponible.') };
    return;
  }

  let prompt = opts.prompt;
  let lastText = '';
  let prev: Target | undefined;

  for (let i = 0; i < chain.length; i++) {
    const target = chain[i]!;
    yield { type: 'attempt', n: i + 1, total: chain.length, target };
    const sessionId = i === 0 ? opts.sessions?.[target.backend] : undefined;
    // les cibles qui peuvent lire le dépôt reçoivent une référence courte vers le fichier de contexte
    // partagé plutôt que l'historique en clair : ça évite de repayer les mêmes tokens à chaque tour.
    const recapText = target.caps.tools && opts.recapFile ? opts.recapFile : opts.recap;
    const needsRecap = i === 0 && !sessionId && recapText;
    // un agent qui reprend sa session connaît déjà le contexte ; un nouvel agent le reçoit une fois
    const ctx = opts.contextText && !sessionId ? `${opts.contextText}\n\n` : '';
    const effective = ctx + (needsRecap ? `${recapText}\n\n${prompt}` : prompt);

    const before = await snapshot(cwd);
    const started = Date.now();
    let text = '';
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    let error: Extract<RunEvent, { type: 'error' }> | undefined;
    let handoff = false;

    try {
      for await (const event of (opts.runner ?? runTarget)({ prompt: effective, cwd, target, signal, sessionId, cfg, det, needsTools: decision.features.needsRepo })) {
        if (event.type === 'text') text += event.delta || !text ? event.text : '\n' + event.text;
        if (event.type === 'usage') {
          inTok += event.inputTokens;
          outTok += event.outputTokens;
          cost += event.costUsd ?? 0;
        }
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
    lastText = text || lastText;
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
        routerMs: i === 0 ? decision.classifierMs : undefined,
        verify,
        prompt: cfg.logging.content ? opts.prompt.slice(0, 500) : undefined,
      });

    if (signal.aborted) {
      log(false, 'skipped');
      yield { type: 'done', ok: false, target, text, handoff: false, message: 'Interrompu.' };
      return;
    }

    const next = chain[i + 1];
    const canEscalate = Boolean(next) && cfg.escalation.enabled;

    if (error) {
      log(false, 'skipped');
      if (canEscalate) {
        yield { type: 'escalate', from: target, to: next!, reason: error.message };
        prompt = retryPrompt(opts.prompt, target, error.message, changedFiles(before, await snapshot(cwd)));
        prev = target;
        continue;
      }
      yield { type: 'done', ok: false, target, text, handoff: false, message: error.message };
      return;
    }

    // --- vérification par les signaux réels (typecheck / lint / tests) plutôt que par la parole du modèle
    const after = await snapshot(cwd);
    const changed = changedFiles(before, after);

    if (handoff || target.terminal) {
      log(true, 'skipped');
      yield { type: 'done', ok: true, target, text, handoff: true, filesChanged: changed };
      return;
    }

    // un modèle gratuit qui « annonce » une modification sans toucher un fichier n'a rien fait
    if (after.isRepo && decision.features.needsEdit && changed.length === 0 && target.level <= 1 && canEscalate) {
      const reason = t('aucune modification détectée alors qu’une modification était attendue');
      log(false, 'fail');
      yield { type: 'escalate', from: target, to: next!, reason };
      prompt = retryPrompt(opts.prompt, target, reason, []);
      prev = target;
      continue;
    }

    const commands = after.isRepo && changed.length ? detectVerifyCommands(cwd, cfg) : [];
    if (commands.length === 0) {
      log(true, 'skipped');
      yield { type: 'done', ok: true, target, text, handoff: false, verified: false, filesChanged: changed };
      return;
    }
    yield { type: 'verify_start', commands };
    const result = await runVerify(cwd, commands, cfg, signal);
    yield { type: 'verify_result', result };
    if (result.ok) {
      log(true, 'pass');
      yield { type: 'done', ok: true, target, text, handoff: false, verified: true, filesChanged: changed };
      return;
    }
    log(false, 'fail');
    const failed = result.steps.find((s) => !s.ok)!;
    if (canEscalate) {
      yield { type: 'escalate', from: target, to: next!, reason: t('échec de « {command} »', { command: failed.command }) };
      prompt = retryPrompt(opts.prompt, target, t('échec de la commande « {command} »', { command: failed.command }), changed, failed.output);
      prev = target;
      continue;
    }
    yield {
      type: 'done',
      ok: false,
      target,
      text,
      handoff: false,
      verified: false,
      message: t('Vérification échouée : {command}', { command: failed.command }),
    };
    return;
  }
  yield { type: 'done', ok: false, target: chain[chain.length - 1] ?? null, text: lastText, handoff: false, message: t('Toutes les tentatives ont échoué.') };
}

import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { ClaudeUsage, Decision, Target } from '../types.js';
import { quotaState } from '../usage/claude.js';
import { readLedger, recentFailureRate, type LedgerEntry } from '../usage/ledger.js';
import { classifyWithLlm, pickRouterModel } from './classifier.js';
import { analyzeByRules, mergeFeatures } from './heuristics.js';
import { decide } from './policy.js';
import { buildTargets, FORCE_ALIASES, parseForce } from './targets.js';
import { t } from '../i18n/index.js';

export interface RouteContext {
  cwd: string;
  cfg: Config;
  det: Detection;
  usage: ClaudeUsage | null;
  /** cible imposée (commande /use) */
  forcedTarget?: Target;
  ledger?: LedgerEntry[];
}

export interface RouteResult {
  /** prompt nettoyé du préfixe @cible */
  prompt: string;
  decision: Decision;
  unknownForce?: string;
}

export function containsSecret(prompt: string, cfg: Config): boolean {
  return cfg.privacy.never_cloud_patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(prompt);
    } catch {
      return false;
    }
  });
}

export async function route(rawPrompt: string, ctx: RouteContext): Promise<RouteResult> {
  const { cfg, det } = ctx;
  const targets = buildTargets(det, cfg);
  const forced = parseForce(rawPrompt, targets);
  const prompt = forced.prompt;
  const forcedTarget = forced.target ?? ctx.forcedTarget;

  const rules = analyzeByRules(prompt);
  let features = rules;
  let classifierMs: number | undefined;
  let classifierModel: string | undefined;

  const rm = pickRouterModel(det, cfg);
  const wantLlm =
    rm && !forcedTarget && (cfg.router.mode === 'always' || rules.confidence < cfg.router.confidence_threshold);
  if (wantLlm) {
    const res = await classifyWithLlm(prompt, ctx.cwd, cfg, det, rm);
    if (res) {
      features = { ...mergeFeatures(rules, res.features), signals: rules.signals } as typeof rules;
      classifierMs = res.ms;
      classifierModel = res.cached ? `${res.model} (cache)` : res.model;
    }
  }

  const ledger = ctx.ledger ?? readLedger(500);
  const decision = decide({
    features,
    targets,
    cfg,
    quota: quotaState(ctx.usage, cfg),
    hardware: det.hardware,
    privacyLocked: containsSecret(prompt, cfg),
    forced: forcedTarget,
    penalized: (t) => {
      const { rate, samples } = recentFailureRate(ledger, t.id, features.category);
      return samples >= 4 && rate >= 0.6;
    },
  });
  decision.classifierMs = classifierMs;
  decision.classifierModel = classifierModel;
  if (forced.unknown) {
    const hint = FORCE_ALIASES.includes(forced.unknown.toLowerCase())
      ? t('Alias @{unknown} désactivé ou indisponible (/tools pour réactiver) — routage automatique.', { unknown: forced.unknown })
      : t('Alias @{unknown} inconnu — routage automatique.', { unknown: forced.unknown });
    decision.warnings.push(hint);
  }
  return { prompt, decision, unknownForce: forced.unknown };
}

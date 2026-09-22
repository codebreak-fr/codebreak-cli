import type { Config, ProfileName } from '../config/schema.js';
import type { HardwareInfo } from '../detect/types.js';
import type { CostKind, Decision, Level, QuotaState, Target, TaskFeatures } from '../types.js';
import { t } from '../i18n/index.js';

export const DEFAULT_PROFILES: Record<ProfileName, Record<number, Level>> = {
  // gratuit d'abord : Claude seulement pour le difficile
  eco: { 1: 0, 2: 0, 3: 1, 4: 3, 5: 3 },
  // défaut : gratuit pour le petit, Sonnet pour le sérieux, Opus pour le critique
  balanced: { 1: 0, 2: 1, 3: 3, 4: 3, 5: 4 },
  // qualité : Claude dès que la tâche n'est pas triviale
  quality: { 1: 1, 2: 3, 3: 3, 4: 4, 5: 4 },
};

export const DEFAULT_CATEGORY_FLOORS: Record<string, Level> = {
  auth_security: 3,
  legal: 3,
};

const COST_RANK: Record<CostKind, number> = { free: 0, included: 1, subscription: 2 };

export interface PolicyInput {
  features: TaskFeatures;
  targets: Target[];
  cfg: Config;
  quota: QuotaState;
  hardware?: Pick<HardwareInfo, 'lowPowerMode'>;
  privacyLocked?: boolean;
  forced?: Target;
  /** true → la cible est écartée (historique d'échecs sur cette catégorie) */
  penalized?: (target: Target) => boolean;
}

export function profileMap(cfg: Config): Record<number, Level> {
  const overrides = cfg.profiles[cfg.profile] ?? {};
  const merged: Record<number, Level> = { ...DEFAULT_PROFILES[cfg.profile] };
  for (const [k, v] of Object.entries(overrides)) merged[Number(k)] = v as Level;
  return merged;
}

const sortTargets = (a: Target, b: Target) =>
  a.level - b.level || COST_RANK[a.cost] - COST_RANK[b.cost] || b.power - a.power;

const clampLevel = (n: number): Level => Math.max(0, Math.min(4, Math.round(n))) as Level;

/** Niveau de capacité requis + raisons, indépendamment des cibles disponibles. */
export function requiredLevel(
  f: TaskFeatures,
  cfg: Config,
  quota: QuotaState,
): { level: Level; reasons: string[]; critical: boolean; floor: Level } {
  const reasons: string[] = [];
  const base = profileMap(cfg)[f.complexity] ?? 1;
  reasons.push(t('complexité {complexity}/5 → niveau {base} (profil {profile})', { complexity: f.complexity, base, profile: cfg.profile }));

  // plancher = exigence de qualité que le quota ne doit pas rogner
  let floor: Level = 0;
  const bump = (lvl: number, why: string) => {
    if (lvl > floor) {
      floor = clampLevel(lvl);
      reasons.push(why);
    }
  };
  const catFloor = { ...DEFAULT_CATEGORY_FLOORS, ...cfg.policy.category_floors }[f.category];
  if (catFloor) bump(catFloor, t('catégorie {category} → minimum niveau {catFloor}', { category: f.category, catFloor }));
  if (f.security) bump(cfg.policy.security_min_level, t('sensible (sécurité) → minimum niveau {security_min_level}', { security_min_level: cfg.policy.security_min_level }));
  if (f.needsMcp) bump(cfg.policy.mcp_min_level, t('outils MCP requis → Claude/Copilot uniquement'));
  if (f.contextSize === 'large') bump(cfg.policy.large_context_min_level, t('contexte large → modèle à grande fenêtre'));

  let level = clampLevel(Math.max(base, floor));

  if (f.confidence < cfg.policy.low_confidence && level < 3) {
    level = clampLevel(level + 1);
    reasons.push(t('confiance faible ({v}) → +1 niveau', { v: f.confidence.toFixed(2) }));
  }

  // sécurité + tâche difficile → niveau préféré (Opus) si le quota le permet
  const critical = f.complexity >= 5 || (f.security && f.complexity >= 4);
  if (f.security && f.complexity >= 4 && level < cfg.policy.security_preferred_level) {
    level = clampLevel(cfg.policy.security_preferred_level);
    reasons.push(t('sécurité + tâche difficile → Opus préféré'));
  }

  // économie de quota : on rogne seulement ce que le plancher n'impose pas
  if ((quota === 'soft' || quota === 'hard') && floor < 3) {
    if (quota === 'soft' && level === 3 && f.complexity <= 3) {
      level = 2;
      reasons.push(t('quota Claude tendu → niveau 2 (Haiku/Copilot) plutôt que Sonnet'));
    }
    if (quota === 'hard' && level >= 3 && f.complexity <= 3) {
      level = 1;
      reasons.push(t('quota Claude critique → modèle gratuit plutôt que Sonnet'));
    }
  }
  return { level, reasons, critical, floor };
}

export function decide(input: PolicyInput): Decision {
  const { features: f, targets, cfg, quota } = input;
  const { level, reasons, critical } = requiredLevel(f, cfg, quota);
  const warnings: string[] = [];
  const privacyLocked = Boolean(input.privacyLocked);

  const base: Decision = {
    features: f,
    requiredLevel: level,
    primary: null,
    chain: [],
    reasons,
    warnings,
    quota,
    degraded: false,
    forced: false,
    privacyLocked,
  };

  if (privacyLocked) {
    reasons.push(t('secret détecté dans la demande → traitement local uniquement'));
    if (cfg.privacy.action === 'block') {
      warnings.push(t('Demande bloquée : elle contient un secret (privacy.action = block).'));
      return base;
    }
  }

  // --- forçage explicite
  if (input.forced) {
    base.forced = true;
    base.primary = input.forced;
    base.chain = [input.forced];
    reasons.unshift(t('forcé → {label}', { label: input.forced.label }));
    if (input.forced.backend === 'claude' && quota === 'stop') {
      warnings.push(t('Quota Claude épuisé : la commande risque d’être refusée.'));
    }
    if (privacyLocked && input.forced.cloud) {
      warnings.push(t('Un secret a été détecté et la cible forcée est dans le cloud.'));
    }
    return base;
  }

  const eligible = (t: Target): boolean => {
    if (t.backend === 'claude') {
      if (quota === 'stop') return false;
      if (t.id === 'claude:opus') {
        if (quota === 'hard') return false;
        if (quota === 'soft' && !critical) return false;
      }
    }
    if (privacyLocked && t.cloud) return false;
    if (f.needsRepo && !t.caps.tools) return false;
    if (f.needsMcp && !t.caps.mcp) return false;
    if (f.vision && !t.caps.vision) return false;
    if (f.contextSize === 'large' && t.caps.contextK < 100) return false;
    if (t.terminal && !cfg.copilot.auto_route) return false;
    if (t.backend === 'ollama' && input.hardware?.lowPowerMode) return false;
    if (input.penalized?.(t)) return false;
    return true;
  };

  const pool = targets.filter(eligible).sort(sortTargets);

  if (quota === 'stop' && targets.some((t) => t.backend === 'claude')) {
    warnings.push(t('Quota Claude épuisé : Claude est désactivé jusqu’à la réinitialisation.'));
  } else if (quota === 'hard') {
    warnings.push(t('Quota Claude critique : Opus interdit, Sonnet réservé aux tâches qui l’exigent.'));
  } else if (quota === 'soft' && targets.some((t) => t.id === 'claude:opus') && !critical) {
    reasons.push(t('quota Claude tendu → Opus réservé aux tâches critiques'));
  }
  if (input.hardware?.lowPowerMode) reasons.push(t('mode économie d’énergie → pas de modèle local'));

  let primary = pool.find((t) => t.level >= level);
  if (!primary && pool.length) {
    // rien d'assez puissant : on prend le meilleur disponible et on prévient
    primary = [...pool].sort((a, b) => b.level - a.level || sortTargets(a, b))[0];
    base.degraded = true;
    warnings.push(t('Aucune cible de niveau {level} disponible : repli sur {label} (niveau {level2}).', { level, label: primary!.label, level2: primary!.level }));
  }
  if (!primary) {
    warnings.push(t('Aucune cible disponible pour cette demande (voir /detect).'));
    return base;
  }

  const chain: Target[] = [primary];
  if (cfg.escalation.enabled && !primary.terminal) {
    const ladder = [...cfg.escalation.ladder].sort((a, b) => a - b);
    for (const step of ladder) {
      if (chain.length >= cfg.escalation.max_attempts) break;
      if (step <= chain[chain.length - 1]!.level) continue;
      const next = pool.find((t) => t.level === step && !t.terminal && t.caps.capture);
      if (next) chain.push(next);
    }
  }
  base.primary = primary;
  base.chain = chain;
  return base;
}

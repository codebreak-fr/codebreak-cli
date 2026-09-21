export type BackendId = 'claude' | 'opencode' | 'ollama' | 'copilot' | 'vibe' | 'gemini' | 'aider' | 'lms' | 'llamacpp';

/** 0 = local gratuit · 1 = cloud gratuit · 2 = milieu de gamme · 3 = Sonnet · 4 = Opus */
export type Level = 0 | 1 | 2 | 3 | 4;

export type CostKind = 'free' | 'included' | 'subscription';

export const CATEGORIES = [
  'frontend',
  'backend',
  'auth_security',
  'integration',
  'legal',
  'content',
  'media',
  'seo_perf',
  'admin_tooling',
  'design',
  'deploy_refactor',
  'testing',
  'question',
  'chore',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type ContextSize = 'small' | 'medium' | 'large';

export interface Target {
  /** ex. "claude:opus", "opencode:opencode/big-pickle", "ollama:ministral-3:8b", "copilot:agent" */
  id: string;
  backend: BackendId;
  /** identifiant passé au backend (alias Claude, provider/modèle OpenCode, tag Ollama…) */
  model: string;
  label: string;
  level: Level;
  cost: CostKind;
  /** ordre de préférence à niveau égal (plus grand = meilleur) */
  power: number;
  cloud: boolean;
  caps: {
    /** peut lire/modifier le dépôt et lancer des commandes */
    tools: boolean;
    mcp: boolean;
    vision: boolean;
    /** la sortie est capturée (sinon: simple passation à un outil externe) */
    capture: boolean;
    contextK: number;
  };
  /** cible qui ne rend pas la main (Copilot dans VS Code) : pas de vérification ni d'escalade */
  terminal?: boolean;
}

export interface TaskFeatures {
  complexity: 1 | 2 | 3 | 4 | 5;
  category: Category;
  needsEdit: boolean;
  /** nécessite l'accès au dépôt (lire des fichiers, lancer des commandes) */
  needsRepo: boolean;
  needsMcp: boolean;
  vision: boolean;
  security: boolean;
  contextSize: ContextSize;
  confidence: number;
  reason: string;
  source: 'rules' | 'llm' | 'merged';
}

export interface QuotaWindow {
  /** 0..1 */
  utilization: number;
  /** epoch secondes */
  resetsAt?: number;
}

export interface ClaudeUsage {
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  status?: string;
  /** epoch ms */
  fetchedAt: number;
}

export type QuotaState = 'unknown' | 'ok' | 'soft' | 'hard' | 'stop';

export interface Decision {
  features: TaskFeatures;
  requiredLevel: Level;
  primary: Target | null;
  /** primary puis paliers d'escalade */
  chain: Target[];
  reasons: string[];
  warnings: string[];
  quota: QuotaState;
  degraded: boolean;
  forced: boolean;
  /** contenu sensible détecté : cloud interdit */
  privacyLocked: boolean;
  classifierMs?: number;
  classifierModel?: string;
}

export type RunEvent =
  | { type: 'session'; id: string }
  /** delta = fragment de flux (à concaténer) ; sinon bloc complet */
  | { type: 'text'; text: string; delta?: boolean }
  /** réflexion intermédiaire (OpenCode --thinking, Vibe…) : affichée en grisé, jamais dans le texte final */
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; name: string; summary: string }
  | { type: 'tool_result'; id: string; ok: boolean; preview: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number; tokensPerSec?: number }
  | { type: 'rate'; usage: Partial<ClaudeUsage> }
  | { type: 'error'; kind: 'quota' | 'auth' | 'crash' | 'unavailable'; message: string }
  | { type: 'handoff'; message: string };

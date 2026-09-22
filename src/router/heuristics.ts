import { t } from '../i18n/index.js';
import type { Category, ContextSize, TaskFeatures } from '../types.js';

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const CATEGORY_PATTERNS: [Category, RegExp][] = [
  ['auth_security', /\b(auth\w*|oauth\w*|otp|2fa|mfa|session\w*|login|connexion|mot de passe|password|token\w*|jwt|csrf|xss|faille\w*|vulnerab\w*|securit\w*|secret\w*|permission\w*|chiffr\w*|encrypt\w*|injection|cookie\w*|better auth)\b/g],
  ['integration', /\b(stripe|brevo|nodemailer|webhook\w*|figma|mcp|newsletter\w*|paiement\w*|abonnement\w*|smtp|sendgrid|api tierce|echeancier|facturation)\b/g],
  ['legal', /\b(rgpd|gdpr|cgv|cgu|mentions legales|conformite|retractation|contrat|attestation|juridique|consentement|droit\w*|transparence ia)\b/g],
  ['media', /\b(audio|video|tts|srt|sous-titre\w*|transcript\w*|timestamp\w*|ffmpeg|narration|voix|vtt)\b/g],
  ['seo_perf', /\b(seo|lighthouse|performance\w*|sitemap|robots\.txt|llms\.txt|accessibilit\w*|rgaa|a11y|contraste\w*|ssr|css critique|core web vitals|lcp|balises? meta|schema\.org|donnees structurees)\b/g],
  ['deploy_refactor', /\b(deploie\w*|deployer|deploy\w*|o2switch|passenger|refactor\w*|refacto\w*|code mort|dead code|nettoie\w*|cleanup|documentation|readme|renomm\w*)\b/g],
  ['backend', /\b(api|hono|drizzle|endpoint\w*|migration\w*|postgres\w*|sql|schema|base de donnees|database|serveur|server|node|middleware\w*|feature flags?|roles?|orm|route serveur)\b/g],
  ['design', /\b(pixel art|branding|logo\w*|favicon\w*|theme\w*|dark mode|palette\w*|couleur\w*|typographie|direction artistique|cover\w*|image og)\b/g],
  ['frontend', /\b(react|jsx|tsx|composant\w*|component\w*|css|tailwind|ui|interface|bouton\w*|button\w*|page\w*|ecran\w*|navigation|onboarding|animation\w*|scroll\w*|responsive|mobile|vite|hook\w*|modal\w*|formulaire\w*|form\w*|lecteur|player|slide\w*|sidebar|menu)\b/g],
  ['testing', /\b(tests?|vitest|jest|e2e|spec|couverture|coverage|mock\w*)\b/g],
  ['content', /\b(redige\w*|rediger|copywriting|cours|chapitre\w*|module\w*|lexique|landing|tarif\w*|offre\w*|texte\w*|contenu\w*|article\w*|traduc\w*|traduis|libelle\w*|prompt\w*)\b/g],
  ['admin_tooling', /\b(admin\w*|dashboard\w*|tableau de bord|eslint|lint\w*|scripts?|cli|outillage|cms|build|standalone|validateur)\b/g],
];

const EDIT_VERBS =
  /\b(ajoute\w*|cree\w*|creer|corrige\w*|modifie\w*|refactor\w*|refacto\w*|implemente\w*|supprime\w*|renomme\w*|remplace\w*|ecris|ecrire|genere\w*|migre\w*|migrer|deploie\w*|fix\w*|add|create|implement\w*|update|remove|rename|replace|write|generate|migrate|deploy|change|changer|mets|integre\w*|construis|fais|realise\w*|reproduis|transforme\w*|branche|configure\w*|optimise\w*|nettoie\w*|installe\w*|redige\w*|rediger|traduis|formate\w*|commit\w*)\b/;
const QUESTION_START =
  /^\s*(explique\w*|pourquoi|comment|c'?est quoi|qu'?est[- ]ce|que fait|what|why|how|explain|resume\w*|decris|describe|quel(le)?s?|est[- ]ce que|peux[- ]tu m'?expliquer|a quoi sert|difference)\b/;
const REPO_REF =
  /\b(ce fichier|cette fonction|ce composant|cette page|ce projet|le projet|le repo|le code|la codebase|src\/|dans le|dans la|dans mon|notre|mon app|l'app)\b|[\w./-]+\.(tsx?|jsx?|json|css|md|sql|ya?ml|html|py|sh|mjs|cjs)\b/;
const FILE_REF = /[\w./-]+\.(tsx?|jsx?|json|css|md|sql|ya?ml|html|py|sh|mjs|cjs)\b/g;

const SCOPE_WORDS =
  /\b(architecture|refonte|refactor\w* (complet|global)|migration|de bout en bout|end[- ]to[- ]end|tout le|toute l'|systeme|plusieurs|integration complete|monorepo|codebase|partout|global\w*|complet|complete|entierement|from scratch|de zero)\b/g;
const HARD_WORDS =
  /\b(race condition|deadlock|fuite memoire|memory leak|intermittent\w*|heisenbug|impossible|bloque\w*|concurren\w*|regression|introuvable|aucune idee|difficile|complexe|tricky|subtil\w*)\b/g;
const SMALL_WORDS =
  /\b(renomme\w*|typo\w*|commentaire\w*|formate\w*|format|prettier|juste|simplement|petit\w*|mini|rapidement|trivial\w*|one[- ]?liner|libelle\w*|message de commit|un test|une fonction|quick|small|tiny)\b/g;
const STEP_WORDS = /\b(puis|ensuite|et aussi|apres ca|then|also|finalement|enfin)\b|^\s*(\d+[.)]|[-*•])\s/gm;
const LARGE_CTX = /\b(tout le projet|toute l'app|codebase|monorepo|tous les fichiers|whole repo|entire)\b/;
const MCP_WORDS = /\b(figma|mcp|notion|linear|jira|slack)\b/;
// vision = image fournie EN ENTRÉE (générer une image OG n'en est pas)
const VISION_WORDS = /\b(figma|screenshot|captures? d'ecran|maquettes?|mockup|(cette |ce )(image|capture|photo|schema))\b/;
const ARCH_WORDS = /\b(architecture|refonte|redesign|repenser|from scratch|de zero)\b/;
const HARD_SECURITY_WORDS = /\b(vulnerab\w*|faille\w*|xss|csrf|injection|audit\w*)\b/;
const SECURITY_WORDS =
  /\b(faille\w*|vulnerab\w*|securit\w*|xss|csrf|injection|secret\w*|chiffr\w*|encrypt\w*|mot de passe|password|2fa|otp|oauth\w*|jwt|session\w*|permission\w*|stripe|paiement\w*|rgpd|gdpr|token\w*|auth\w*|credential\w*|cle api|api key)\b/;

export interface Signals {
  categoryScores: Partial<Record<Category, number>>;
  notes: string[];
}

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/** Analyse déterministe de la demande (FR/EN) : rapide, sans LLM. */
export function analyzeByRules(prompt: string): TaskFeatures & { signals: Signals } {
  const text = normalize(prompt);
  const notes: string[] = [];

  // --- catégorie
  const scores: Partial<Record<Category, number>> = {};
  for (const [cat, re] of CATEGORY_PATTERNS) {
    const n = count(re, text);
    if (n) scores[cat] = n;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]) as [Category, number][];
  const security = SECURITY_WORDS.test(text);

  const hasEdit = EDIT_VERBS.test(text);
  const isQuestion = QUESTION_START.test(text) || /\?\s*$/.test(text.trim());
  const needsEdit = hasEdit || !isQuestion;
  let category: Category = ranked[0]?.[0] ?? (isQuestion && !hasEdit ? 'question' : 'other');
  // une question générale sans mot-clé de domaine reste "question"
  if (!ranked.length && isQuestion) category = 'question';
  // la sécurité prime dès qu'elle est explicitement en jeu
  if (security && (scores.auth_security ?? 0) > 0) category = 'auth_security';
  if (!ranked.length && !isQuestion && text.length < 60 && count(SMALL_WORDS, text)) category = 'chore';

  // --- complexité
  let score = 2;
  const len = prompt.length;
  if (len > 300) (score += 0.5), notes.push(t('demande longue'));
  if (len > 800) (score += 1), notes.push(t('demande très détaillée'));
  const steps = count(STEP_WORDS, text);
  if (steps >= 3) (score += 1), notes.push(t('{steps} étapes', { steps }));
  const scope = Math.min(2, count(SCOPE_WORDS, text));
  if (scope) (score += scope), notes.push(t('portée large'));
  const hard = Math.min(2, count(HARD_WORDS, text));
  if (hard) (score += hard), notes.push(t('problème délicat'));
  const small = Math.min(2, count(SMALL_WORDS, text));
  if (small) (score -= small), notes.push(t('tâche réduite'));
  if (security) (score += 1), notes.push(t('sécurité'));
  if (security && HARD_SECURITY_WORDS.test(text)) (score += 1), notes.push(t('audit/correction de failles'));
  if (ARCH_WORDS.test(text)) (score += 1), notes.push(t('changement d’architecture'));
  if (category === 'legal' || category === 'integration' || category === 'media') score += 0.5;
  if (!needsEdit && category === 'question') score -= 0.5;
  const complexity = clamp(Math.round(score), 1, 5) as TaskFeatures['complexity'];

  // --- contexte
  const fileRefs = count(FILE_REF, text);
  let contextSize: ContextSize = 'medium';
  if (LARGE_CTX.test(text) || scope >= 2 || len > 1500) contextSize = 'large';
  else if (len < 160 && fileRefs <= 1) contextSize = 'small';

  const needsMcp = MCP_WORDS.test(text);
  const vision = VISION_WORDS.test(text);
  const needsRepo = needsEdit || REPO_REF.test(text);

  // --- confiance : catégorie claire + complexité tranchée
  let confidence = 0.45;
  if (ranked.length) confidence += ranked[0]![1] >= 2 || ranked.length === 1 ? 0.2 : 0.1;
  if (score <= 1.5 || score >= 4) confidence += 0.15;
  if (hasEdit) confidence += 0.05;
  if (len < 25) confidence -= 0.2;
  if (ranked.length >= 3 && ranked[0]![1] === ranked[1]![1]) confidence -= 0.1;
  confidence = clamp(confidence, 0.2, 0.95);

  const reason = [category.replace('_', '/'), ...notes].join(' · ');
  return {
    complexity,
    category,
    needsEdit,
    needsRepo,
    needsMcp,
    vision,
    security,
    contextSize,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    source: 'rules',
    signals: { categoryScores: scores, notes },
  };
}

/** Fusionne règles et LLM : les contraintes critiques (sécurité, MCP) des règles priment. */
export function mergeFeatures(rules: TaskFeatures, llm: Partial<TaskFeatures>): TaskFeatures {
  const complexity = llm.complexity
    ? (clamp(Math.round(rules.complexity * 0.4 + llm.complexity * 0.6), 1, 5) as TaskFeatures['complexity'])
    : rules.complexity;
  // si les deux divergent fortement, on retient le plus élevé (prudence sur la qualité)
  const gap = llm.complexity ? Math.abs(rules.complexity - llm.complexity) : 0;
  const finalComplexity =
    gap >= 2 ? (Math.max(rules.complexity, llm.complexity ?? 1) as TaskFeatures['complexity']) : complexity;
  return {
    complexity: finalComplexity,
    category: rules.security ? rules.category : (llm.category ?? rules.category),
    needsEdit: llm.needsEdit ?? rules.needsEdit,
    needsRepo: rules.needsRepo || (llm.needsRepo ?? false),
    needsMcp: rules.needsMcp || (llm.needsMcp ?? false),
    vision: rules.vision || (llm.vision ?? false),
    security: rules.security || (llm.security ?? false),
    contextSize: rules.contextSize === 'large' || llm.contextSize === 'large' ? 'large' : (llm.contextSize ?? rules.contextSize),
    confidence: Math.max(rules.confidence, llm.confidence ?? 0),
    reason: llm.reason || rules.reason,
    source: 'merged',
  };
}

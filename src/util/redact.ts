/**
 * Masquage des secrets avant qu'un texte (sortie de CLI, prompt, environnement) ne soit écrit dans un fichier
 * ou un journal. Volontairement conservateur : mieux vaut masquer un faux positif que laisser fuiter une clé.
 */

const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;

const PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}/g],
  ['hf-token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['auth-header', /(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s'",;]+/gi],
  ['bearer', /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi],
  ['cookie', /(\b(?:set-)?cookie\s*[:=]\s*)[^\n]+/gi],
  ['url-credentials', /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi],
];

// `NOM=valeur` / `"nom": "valeur"` dont le nom évoque un secret
const SECRET_NAME = /(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|auth|cookie|session[_-]?id)/i;
const ASSIGNMENT = /(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|passwd|credential|private[_-]?key|auth|cookie|session[_-]?id)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)([^\s'",;}]{6,})\2/gi;

/** Valeurs d'environnement secrètes courantes (noms évocateurs, valeur assez longue pour éviter les faux positifs). */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v && v.length >= 8 && SECRET_NAME.test(k))
    .map(([, v]) => v!)
    .sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface RedactOptions {
  /** valeurs exactes supplémentaires à masquer (défaut : secrets de l'environnement courant) */
  values?: string[];
}

export function redact(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const value of opts.values ?? secretEnvValues()) out = out.replace(new RegExp(escapeRe(value), 'g'), PLACEHOLDER('env'));
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, (...m) => {
      const prefix = typeof m[1] === 'string' && !/^\d+$/.test(m[1]) && kind !== 'private-key' ? m[1] : '';
      return `${prefix}${PLACEHOLDER(kind)}`;
    });
  }
  out = out.replace(ASSIGNMENT, (_m, name: string, quote: string) => `${name}${quote}${PLACEHOLDER('secret')}${quote}`);
  return out;
}

/** true si `text` contient quelque chose que `redact` masquerait. */
export const containsSecret = (text: string, opts?: RedactOptions) => redact(text, opts) !== text;

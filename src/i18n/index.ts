import { en } from './en.js';

export type Lang = 'fr' | 'en';
export type LangSetting = Lang | 'auto';

let current: Lang = 'fr';

/**
 * Langue effective, par priorité : `CODEBREAK_LANG` (posée aussi par `--lang`), réglage `language` de la config,
 * locale du système (fr* → français), sinon anglais.
 */
export function resolveLang(setting: LangSetting = 'auto', env: NodeJS.ProcessEnv = process.env): Lang {
  const forced = env.CODEBREAK_LANG?.toLowerCase();
  if (forced?.startsWith('fr')) return 'fr';
  if (forced?.startsWith('en')) return 'en';
  if (setting === 'fr' || setting === 'en') return setting;
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  return locale.startsWith('fr') ? 'fr' : 'en';
}

export const setLang = (lang: Lang) => void (current = lang);
export const getLang = (): Lang => current;

/** Nombre avec `digits` décimales, au format de la langue (« 1,5 » en français, « 1.5 » en anglais). */
export function num(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  return current === 'fr' ? s.replace('.', ',') : s;
}

/**
 * Traduit une chaîne. La clé est le texte français d'origine ; `{nom}` est remplacé par `vars.nom`.
 * En français la clé est rendue telle quelle ; en anglais on cherche `en[clé]` (repli : la clé).
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  const text = current === 'en' ? (en[key] ?? key) : key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

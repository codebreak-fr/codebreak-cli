import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/catalog/categories.js';
import { fmtGB, verdictLabel } from '../src/catalog/present.js';
import { en } from '../src/i18n/en.js';
import { getLang, num, resolveLang, setLang, t } from '../src/i18n/index.js';
import { COMMANDS } from '../src/ui/commands.js';
import { KIND_LABEL } from '../src/ui/ContextPanel.js';
import { LEVEL_NAMES } from '../src/ui/format.js';

const SRC = join(__dirname, '..', 'src');

/** Clés passées à `t('…')` dans le code source (chaînes et gabarits sans expression). */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f) && !p.includes(`${join('src', 'i18n')}`)) {
        const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't') {
            const a = n.arguments[0];
            if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) keys.set(a.text, relative(SRC, p));
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
  };
  walk(SRC);
  return keys;
}

/** Textes définis en constantes de module (traduits à l'affichage). */
const constantKeys = () => [
  ...COMMANDS.flatMap((c) => [c.description, c.args].filter((x): x is string => Boolean(x))),
  ...CATEGORIES.flatMap((c) => [c.label, c.description]),
  ...LEVEL_NAMES,
  ...Object.values(KIND_LABEL),
  'Recommandé', 'Alternative', 'Lent', 'Exclu',
  'éco', 'équilibré', 'qualité',
  'mémoire unifiée',
  '↑↓', 'naviguer', 'Entrée', 'choisir', 'Esc', 'annuler', 'valider', 'retour', 'détails', 'installer', 'supprimer', 'fermer', 'rafraîchir', 'interrompre', 'Espace', 'coche/décoche', 'tout', 'rien', 'r', 'i', 'a', 'n',
];

afterEach(() => setLang('fr'));

describe('internationalisation', () => {
  it('toute chaîne passée à t() a une traduction anglaise', () => {
    const missing = [...usedKeys()].filter(([k]) => !(k in en)).map(([k, f]) => `${f}: ${k.slice(0, 70)}`);
    expect(missing).toEqual([]);
  });
  it('toute constante affichée a une traduction anglaise', () => {
    expect(constantKeys().filter((k) => !(k in en))).toEqual([]);
  });
  it('pas d’entrée anglaise orpheline (clé jamais utilisée)', () => {
    const used = new Set([...usedKeys().keys(), ...constantKeys()]);
    expect(Object.keys(en).filter((k) => !used.has(k)).map((k) => k.slice(0, 70))).toEqual([]);
  });
  it('les {variables} de la traduction existent dans la clé française', () => {
    const bad = Object.entries(en).filter(([k, v]) => {
      const vars = new Set([...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      return [...v.matchAll(/\{(\w+)\}/g)].some((m) => !vars.has(m[1]));
    });
    expect(bad.map(([k]) => k)).toEqual([]);
  });
  it('les espaces de bord sont conservés (fragments concaténés dans les vues)', () => {
    const bad = Object.entries(en).filter(([k, v]) => k.startsWith(' ') !== v.startsWith(' ') || k.endsWith(' ') !== v.endsWith(' '));
    expect(bad.map(([k]) => JSON.stringify(k))).toEqual([]);
  });
});

describe('langue', () => {
  it('résolution : CODEBREAK_LANG > config > locale système > anglais', () => {
    expect(resolveLang('auto', { LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(resolveLang('auto', { LANG: 'en_US.UTF-8' })).toBe('en');
    expect(resolveLang('auto', { LC_ALL: 'fr_CA', LANG: 'en_US' })).toBe('fr');
    expect(resolveLang('en', { LANG: 'fr_FR' })).toBe('en');
    expect(resolveLang('fr', { LANG: 'en_US' })).toBe('fr');
    expect(resolveLang('fr', { CODEBREAK_LANG: 'en' })).toBe('en');
    expect(resolveLang('auto', { LANG: 'C' })).toBe('en');
  });
  it('t() : interpolation, repli sur la clé, français inchangé', () => {
    setLang('fr');
    expect(t('Profil → {arg}', { arg: 'eco' })).toBe('Profil → eco');
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t('Profil → {arg}', { arg: 'eco' })).toBe('Profile → eco');
    expect(t('chaîne jamais traduite {x}', { x: 1 })).toBe('chaîne jamais traduite 1');
  });
  it('nombres et unités suivent la langue', () => {
    setLang('fr');
    expect(num(1.5)).toBe('1,5');
    expect(fmtGB(5.2)).toBe('5,2 Go');
    setLang('en');
    expect(num(1.5)).toBe('1.5');
    expect(fmtGB(5.2)).toBe('5.2 GB');
    expect(fmtGB(undefined)).toBe('unknown');
    expect(verdictLabel('recommended')).toBe('Recommended');
  });
  it('les commandes et catégories s’affichent en anglais', () => {
    setLang('en');
    expect(t(COMMANDS.find((c) => c.name === '/discover')!.description)).toMatch(/^Discover, install and delete/);
    expect(t(CATEGORIES.find((c) => c.id === 'general')!.label)).toBe('General / Chat');
    expect(t(LEVEL_NAMES[1])).toBe('free');
  });
});

import { describe, expect, it } from 'vitest';
import { expandPastes, isLongPaste, PASTE_CHARS, wordLeft, wordRight } from '../src/ui/InputBox.js';

describe('repli des collages longs (comme Claude Code)', () => {
  it('un texte court reste tel quel', () => {
    expect(isLongPaste('bonjour', 40)).toBe(false);
    expect(isLongPaste('ligne 1\nligne 2', 40)).toBe(false);
  });

  it('un collage > 800 caractères est replié', () => {
    const big = 'x'.repeat(PASTE_CHARS + 1);
    expect(isLongPaste(big, 40)).toBe(true);
  });

  it('un collage de plus de 3 lignes est replié', () => {
    expect(isLongPaste('a\nb\nc\nd', 40)).toBe(true);
    expect(isLongPaste('a\nb\nc', 40)).toBe(false);
  });

  it('le seuil de lignes baisse sur une fenêtre courte', () => {
    expect(isLongPaste('a\nb\nc', 11)).toBe(true); // <=12 lignes : 2 lignes max
    expect(isLongPaste('a\nb', 9)).toBe(true); // <=10 lignes : 1 ligne max
    expect(isLongPaste('a', 9)).toBe(false);
  });

  it('expandPastes remplace le placeholder par le contenu complet', () => {
    const map = new Map<number, string>([[1, 'suite de lignes\n---\ncontenu']]);
    expect(expandPastes('regarde [Texte collé #1 +2 lignes] ensuite', map)).toBe('regarde suite de lignes\n---\ncontenu ensuite');
  });

  it('expandPastes laisse un placeholder inconnu intact', () => {
    expect(expandPastes('elle a sauté au #42', new Map())).toBe('elle a sauté au #42');
  });
});

describe('navigation par mot (Ctrl/Option+←→)', () => {
  const s = 'ajoute un test  pour parse()';
  it('wordLeft saute au début du mot précédent', () => {
    expect(wordLeft(s, s.length)).toBe(s.lastIndexOf('parse()'));
    expect(wordLeft(s, s.lastIndexOf('pour'))).toBe(s.lastIndexOf('test'));
    expect(wordLeft(s, 0)).toBe(0);
  });
  it('wordRight saute à la fin du mot suivant', () => {
    expect(wordRight(s, 0)).toBe('ajoute'.length);
    expect(wordRight(s, s.length)).toBe(s.length);
  });
  it('ignore les espaces multiples', () => {
    const i = s.indexOf('test') + 4; // juste après "test", avant le double espace
    expect(wordRight(s, i)).toBe(s.indexOf('pour') + 4);
  });
});
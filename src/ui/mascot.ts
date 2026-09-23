import { color } from './theme.js';

/**
 * Logo CodeBreak (cb-mark.svg) : 3×4 pixels, un « C » brisé. Chaque pixel est agrandi ×2 pour rester lisible :
 * 6×8 pixels = 4 lignes de texte en demi-blocs, comme le texte à côté. Cellule = couleur hex ou null (transparent).
 */
const MARK = [
  [0, 1, 1],
  [1, 0, 0],
  [1, 0, 0],
  [0, 1, 1],
];
const SCALE = 2;

export const MASCOT: (string | null)[][] = MARK.flatMap((row) => {
  const wide = row.flatMap((on) => Array<string | null>(SCALE).fill(on ? color.brand : null));
  return Array.from({ length: SCALE }, () => [...wide]);
});

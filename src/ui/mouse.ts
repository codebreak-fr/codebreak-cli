/**
 * Souris en mode plein écran : molette pour faire défiler l'historique, clic sur « Aller en bas ».
 * Le terminal envoie des séquences SGR (`ESC [ < b ; x ; y M|m`) qu'Ink transmet telles quelles à
 * useInput (sans l'ESC) : on les décode ici et les autres gestionnaires de saisie doivent les ignorer.
 */
export interface MouseEvent {
  kind: 'wheelUp' | 'wheelDown' | 'press' | 'release';
  /** colonne et ligne, 0-based */
  x: number;
  y: number;
}

const SGR = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseMouse(input: string): MouseEvent | null {
  const m = SGR.exec(input);
  if (!m) return null;
  const b = Number(m[1]) & ~(4 | 8 | 16); // retire Maj/Alt/Ctrl
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  if (b & 64) return { kind: b & 1 ? 'wheelDown' : 'wheelUp', x, y };
  return { kind: m[4] === 'M' ? 'press' : 'release', x, y };
}

export const isMouseInput = (input: string) => SGR.test(input);

/**
 * Active le report souris (clics + molette, sans le suivi des mouvements) et renvoie de quoi le couper.
 * Actif par défaut. Tant que le terminal reporte la souris, la sélection native passe par
 * Option (macOS) ou Maj (Linux/Windows) + glisser. CODEBREAK_MOUSE=0 le désactive (sélection
 * libre, défilement au clavier avec PageUp/PageDown).
 */
export function enableMouse(): () => void {
  if (!process.stdout.isTTY || process.env.CODEBREAK_MOUSE === '0') return () => {};
  process.stdout.write('\x1b[?1000h\x1b[?1006h');
  const off = () => {
    process.stdout.write('\x1b[?1006l\x1b[?1000l');
    process.off('exit', off);
  };
  process.on('exit', off);
  return off;
}

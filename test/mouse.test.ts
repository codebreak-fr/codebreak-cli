import { describe, expect, it } from 'vitest';
import { isMouseInput, parseMouse } from '../src/ui/mouse.js';

describe('souris SGR (plein écran)', () => {
  it('décode la molette, avec ou sans ESC et modificateurs', () => {
    expect(parseMouse('[<64;10;5M')).toEqual({ kind: 'wheelUp', x: 9, y: 4 });
    expect(parseMouse('\x1b[<65;1;1M')).toEqual({ kind: 'wheelDown', x: 0, y: 0 });
    expect(parseMouse('[<80;3;3M')?.kind).toBe('wheelUp'); // Ctrl+molette
  });

  it('distingue appui et relâchement du clic', () => {
    expect(parseMouse('[<0;12;30M')).toEqual({ kind: 'press', x: 11, y: 29 });
    expect(parseMouse('[<0;12;30m')?.kind).toBe('release');
  });

  it('ignore la saisie normale', () => {
    expect(parseMouse('[<abc')).toBeNull();
    expect(isMouseInput('bonjour')).toBe(false);
    expect(isMouseInput('[<64;10;5M')).toBe(true);
  });
});

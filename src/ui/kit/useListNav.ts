import { useInput } from 'ink';
import { useEffect, useState } from 'react';

const clamp = (i: number, length: number) => Math.min(Math.max(0, i), Math.max(0, length - 1));

/** Curseur de liste : ↑↓ (avec bouclage). `active=false` suspend la capture des touches. */
export function useListNav(length: number, initial = 0, active = true) {
  const [sel, setSel] = useState(clamp(initial, length));
  useEffect(() => setSel((s) => clamp(s, length)), [length]);
  useInput(
    (_input, key) => {
      if (length === 0) return;
      if (key.upArrow) setSel((s) => (s + length - 1) % length);
      else if (key.downArrow) setSel((s) => (s + 1) % length);
    },
    { isActive: active },
  );
  return [sel, setSel] as const;
}

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { color } from '../theme.js';

/** Cellule de libellé (colonne de gauche des fiches et panneaux d'état). */
export function Label({ children, width = 11 }: { children: string; width?: number }) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={color.dim}>{children}</Text>
    </Box>
  );
}

/** Ligne « libellé  valeur » alignée (fiches, résumé machine, panneaux d'état). */
const isPlain = (c: ReactNode): boolean => typeof c === 'string' || typeof c === 'number' || (Array.isArray(c) && c.every(isPlain));

export function Field({ label, width = 11, children }: { label: string; width?: number; children?: ReactNode }) {
  return (
    <Box>
      <Label width={width}>{label}</Label>
      <Box flexShrink={1}>{isPlain(children) ? <Text wrap="truncate-end">{children}</Text> : children}</Box>
    </Box>
  );
}

export const Ok = ({ ok }: { ok: boolean }) => <Text color={ok ? color.ok : color.err}>{ok ? '✔' : '✘'}</Text>;

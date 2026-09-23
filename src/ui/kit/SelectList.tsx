import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { color } from '../theme.js';
import { useListNav } from './useListNav.js';

export interface ListItem<T> {
  label: string;
  hint?: string;
  value: T;
  disabled?: boolean;
}

/** Ligne de liste : marqueur ❯ et couleur d'accent sur la sélection. */
export function ListRow({ selected, dim, children }: { selected: boolean; dim?: boolean; children: ReactNode }) {
  return (
    <Text color={selected ? color.accentStrong : undefined} bold={selected} dimColor={dim && !selected} wrap="truncate-end">
      {selected ? '❯ ' : '  '}
      {children}
    </Text>
  );
}

/** Liste de choix : ↑↓ pour naviguer, Entrée pour valider. `render` remplace l'affichage d'une ligne. */
export function SelectList<T>({
  items,
  initial = 0,
  onSelect,
  onCursor,
  render,
  active = true,
}: {
  items: ListItem<T>[];
  initial?: number;
  onSelect: (value: T, index: number) => void;
  onCursor?: (index: number) => void;
  render?: (item: ListItem<T>, selected: boolean, index: number) => ReactNode;
  active?: boolean;
}) {
  const [sel] = useListNav(items.length, initial, active);
  useInput(
    (_input, key) => {
      if (key.upArrow || key.downArrow) onCursor?.(sel);
      if (key.return && items[sel] && !items[sel]!.disabled) onSelect(items[sel]!.value, sel);
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      {items.map((it, i) =>
        render ? (
          <Box key={i} flexDirection="column">
            {render(it, i === sel, i)}
          </Box>
        ) : (
          <ListRow key={i} selected={i === sel} dim={it.disabled}>
            {it.label}
            {it.hint ? <Text color={color.dim}>  {it.hint}</Text> : null}
          </ListRow>
        ),
      )}
    </Box>
  );
}

import { Panel, SelectList, type ListItem } from './kit/index.js';
import { useInput } from 'ink';

export interface PickerOption<T> {
  label: string;
  hint?: string;
  value: T;
}

const HINTS = [['↑↓', 'naviguer'], ['Entrée', 'choisir'], ['Esc', 'annuler']] as const;

/** Sélecteur simple : une liste de choix dans un panneau. */
export function Picker<T>({
  title,
  options,
  initial = 0,
  onSelect,
  onCancel,
}: {
  title: string;
  options: PickerOption<T>[];
  initial?: number;
  onSelect: (value: T) => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) onCancel();
  });
  const items: ListItem<T>[] = options;
  return (
    <Panel title={title} hints={HINTS}>
      <SelectList items={items} initial={initial} onSelect={onSelect} />
    </Panel>
  );
}

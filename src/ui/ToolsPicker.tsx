import { Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import { ALL_BACKENDS, backendToggleState } from '../router/targets.js';
import type { BackendId } from '../types.js';
import { ListRow, Panel, useListNav } from './kit/index.js';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

export interface ToolsPickerProps {
  cfg: Config;
  det: Detection;
  onSubmit: (enabled: Record<BackendId, boolean>) => void;
  onCancel: () => void;
}

const box = (on: boolean) => (on ? '[x]' : '[ ]');

const HINTS = [['Espace', 'coche/décoche'], ['Entrée', 'valider'], ['Esc', 'annuler'], ['a', 'tout'], ['n', 'rien']] as const;

/** Liste à bascule des outils IA : Espace coche/décoche, Entrée valide, Esc annule. */
export function ToolsPicker({ cfg, det, onSubmit, onCancel }: ToolsPickerProps) {
  const order = useMemo(() => ALL_BACKENDS.map((b) => b.id), []);
  const [state, setState] = useState<Record<BackendId, boolean>>(() => backendToggleState(cfg));
  const [sel] = useListNav(order.length);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.return) return onSubmit(state);
    const lower = input.toLowerCase();
    if (lower === 'a' || lower === 'n') return setState(Object.fromEntries(order.map((id) => [id, lower === 'a'])) as Record<BackendId, boolean>);
    if (input === ' ' || lower === 'x') {
      const id = order[sel]!;
      setState({ ...state, [id]: !state[id] });
    }
  });

  return (
    <Panel title={t('Outils IA utilisés pour le routage')} subtitle={t('Décoché = jamais appelé')} hints={HINTS}>
      {ALL_BACKENDS.map(({ id, label }, i) => {
        const info = det[id];
        const on = state[id];
        return (
          <ListRow key={id} selected={i === sel} dim={!info.installed}>
            <Text color={on && info.installed ? color.ok : on ? color.warn : color.dim}>{box(on)} </Text>
            {label.padEnd(18)}
            <Text color={color.dim}>{info.installed ? (info.ready ? (on ? '' : t(' · désactivé')) : ` · ${info.detail || t('non prêt')}`) : t(' · non installé')}</Text>
          </ListRow>
        );
      })}
    </Panel>
  );
}

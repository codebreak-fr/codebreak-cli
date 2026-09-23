import { Text } from 'ink';
import { Fragment } from 'react';
import { t } from '../../i18n/index.js';
import { color } from '../theme.js';

/** [touche, action] — affichés en pied de panneau, toujours dans le même format. */
export type Hint = readonly [key: string, label: string];

export function KeyHints({ hints }: { hints: readonly Hint[] }) {
  return (
    <Text color={color.dim}>
      {hints.map(([key, label], i) => (
        <Fragment key={key + label}>
          {i > 0 ? ' · ' : ''}
          <Text color={color.accent}>{t(key)}</Text> {t(label)}
        </Fragment>
      ))}
    </Text>
  );
}

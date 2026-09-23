import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';
import { copyText } from '../util/clipboard.js';
import { ListRow, Panel } from './kit/index.js';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

export interface CopyItem {
  id: number;
  label: string;
  text: string;
}

interface Props {
  items: CopyItem[];
  onClose: () => void;
  onDone: (item: CopyItem) => void;
}

export function CopyPicker({ items, onClose, onDone }: Props) {
  const { rows, columns } = useWindowSize();
  const [sel, setSel] = useState(() => Math.max(0, items.length - 1));
  const [copied, setCopied] = useState(false);

  const idx = Math.min(sel, Math.max(0, items.length - 1));
  const item = items[idx];

  useEffect(() => {
    setSel((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!item) return;
    setCopied(false);
    void copyText(item.text).then((ok) => setCopied(ok));
  }, [item?.id]);

  const copiedFlag = copied;
  const maxPreview = Math.max(4, Math.min(10, rows - 9));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow) setSel((s) => (items.length === 0 ? 0 : (s <= 0 ? items.length - 1 : s - 1)));
    else if (key.downArrow) setSel((s) => (items.length === 0 ? 0 : (s + 1) % items.length));
    else if (key.return) {
      if (item) {
        void copyText(item.text);
        onDone(item);
      } else {
        onClose();
      }
    }
  });

  return (
    <Panel title={t('Copie rapide — {v}', { v: items.length ? `${idx + 1}/${items.length}` : t('aucun message') })} hints={[['↑↓', 'naviguer'], [t('Entrée'), 'copier'], ['Esc', 'annuler']]}>
      {items.map((it, i) => (
        <ListRow key={it.id} selected={i === idx}>
          {it.label}
        </ListRow>
      ))}
      {item ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={color.dim} paddingX={1}>
          {item.text
            .split('\n')
            .slice(0, maxPreview)
            .map((line, i) => (
              <Text key={i} color={color.dim}>
                {line.slice(0, Math.max(1, columns - 8)) || ' '}
              </Text>
            ))}
          {item.text.split('\n').length > maxPreview ? <Text color={color.dim}>… {item.text.split('\n').length - maxPreview} {t('lignes supplémentaires')}</Text> : null}
          <Text color={copiedFlag ? color.ok : color.err}>{copiedFlag ? t('☑ copié au presse-papiers') : t('copie impossible sur ce système')}</Text>
        </Box>
      ) : null}
    </Panel>
  );
}
import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { fmtDuration, fmtTokens } from './format.js';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export function Spinner({ label, startedAt, tokens }: { label: string; startedAt: number; tokens?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 110);
    return () => clearInterval(t);
  }, []);
  const frame = FRAMES[Math.floor((Date.now() - startedAt) / 110) % FRAMES.length];
  return (
    <Text>
      <Text color={color.brand}>{frame} </Text>
      <Text color={color.brand}>{label}…</Text>
      <Text color={color.dim}>
        {' '}
        ({fmtDuration(Date.now() - startedAt)}
        {tokens ? ` · ↓ ${fmtTokens(tokens)} tokens` : ''} {t('· esc pour interrompre)')}</Text>
    </Text>
  );
}

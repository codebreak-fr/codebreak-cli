import { Box, Text } from 'ink';
import type { Config } from '../config/schema.js';
import type { RouterModel } from '../router/classifier.js';
import type { ClaudeUsage } from '../types.js';
import { ellipsizePath } from './format.js';
import { QuotaLine } from './panels.js';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

const PROFILE_LABEL = { eco: 'éco', balanced: 'équilibré', quality: 'qualité' } as const;

export function Footer({
  cfg,
  usage,
  router,
  forced,
  cwd,
  columns,
}: {
  cfg: Config;
  usage: ClaudeUsage | null;
  router: RouterModel | null;
  forced?: string;
  cwd: string;
  columns: number;
}) {
  const dir = (
    <Text>
      <Text color={color.dim}>cwd </Text>
      <Text color={color.accent}>{ellipsizePath(cwd, Math.max(20, columns - 12))}</Text>
    </Text>
  );
  const left = (
    <Text color={color.dim}>
      <Text color={color.brand}>⏵⏵</Text> {t('profil')} {t(PROFILE_LABEL[cfg.profile])}
      {forced ? <Text color={color.warn}> {t('· forcé @')}{forced}</Text> : null}
      {cfg.verify.mode === 'off' ? t(' · vérif. off') : ''} <Text color={color.dim}>{t('(shift+tab · ctrl+y copier)')}</Text>
    </Text>
  );
  const right = (
    <Text>
      <Text color={color.dim}>routeur </Text>
      <Text color={color.route}>{router ? router.label : t('règles')}</Text>
      <Text color={color.dim}> · </Text>
      <QuotaLine usage={usage} cfg={cfg} compact />
    </Text>
  );
  if (columns < 105) {
    return (
      <Box flexDirection="column" paddingX={2}>
        {dir}
        {left}
        {right}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={2}>
      {dir}
      <Box justifyContent="space-between">
        {left}
        {right}
      </Box>
    </Box>
  );
}

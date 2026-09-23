import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { color } from '../theme.js';
import { KeyHints, type Hint } from './KeyHints.js';

/** Cadre commun à tous les panneaux interactifs (sélecteurs, outils, copie, Discovery). */
export function Panel({
  title,
  subtitle,
  hints,
  borderColor = color.brand,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  hints?: readonly Hint[];
  borderColor?: string;
  children?: ReactNode;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={2}>
      <Text bold>{title}</Text>
      {subtitle ? <Text color={color.dim}>{subtitle}</Text> : null}
      {children ? (
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
      ) : null}
      {hints?.length ? (
        <Box marginTop={1}>
          <KeyHints hints={hints} />
        </Box>
      ) : null}
    </Box>
  );
}

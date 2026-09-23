import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <Text key={`${keyBase}-${i++}`} color={color.accent}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else {
      out.push(
        <Text key={`${keyBase}-${i++}`} bold>
          {tok.slice(2, -2)}
        </Text>,
      );
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Rendu Markdown minimal : titres, listes, code (blocs et inline), gras. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\s+$/, '').split('\n');
  const nodes: ReactNode[] = [];
  let code: string[] | null = null;
  for (const [idx, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      if (code) {
        nodes.push(
          <Box key={idx} flexDirection="column" paddingLeft={1} borderStyle="single" borderColor={color.dim} borderLeft borderRight={false} borderTop={false} borderBottom={false}>
            <Text color={color.accent}>{t('⧉ Copier le code · Ctrl+Shift+C')}</Text>
            {code.map((l, j) => (
              <Text key={j} color={color.dim}>
                {l || ' '}
              </Text>
            ))}
          </Box>,
        );
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      nodes.push(
        <Text key={idx} bold color={h[1]!.length <= 2 ? color.brand : undefined}>
          {h[2]}
        </Text>,
      );
      continue;
    }
    const li = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      nodes.push(
        <Text key={idx}>
          {li[1]}
          <Text color={color.dim}>{/\d/.test(li[2]!) ? li[2] : '•'} </Text>
          {inline(li[3]!, String(idx))}
        </Text>,
      );
      continue;
    }
    nodes.push(<Text key={idx}>{line.length ? inline(line, String(idx)) : ' '}</Text>);
  }
  const rest = code as string[] | null;
  if (rest) {
    nodes.push(
      <Box key="tail" flexDirection="column" paddingLeft={1}>
        <Text color={color.accent}>{t('⧉ Copier le code · Ctrl+Shift+C')}</Text>
        {rest.map((l, j) => (
          <Text key={j} color={color.dim}>
            {l || ' '}
          </Text>
        ))}
      </Box>,
    );
  }
  return <Box flexDirection="column">{nodes}</Box>;
}

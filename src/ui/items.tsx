import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { VerifyResult } from '../exec/verify.js';
import type { RouterModel } from '../router/classifier.js';
import type { ClaudeUsage, Decision, Target } from '../types.js';
import { fmtDuration, fmtTokens } from './format.js';
import { Markdown } from './Markdown.js';
import { RouteView, Welcome } from './panels.js';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

export interface WelcomeProps {
  version: string;
  cwd: string;
  det: Detection;
  usage: ClaudeUsage | null;
  cfg: Config;
  router: RouterModel | null;
}

export type Item = { id: number } & (
  | { kind: 'welcome'; props: WelcomeProps }
  | { kind: 'user'; text: string }
  | { kind: 'route'; decision: Decision; dryRun?: boolean }
  | { kind: 'assistant'; text: string }
  /** réflexion intermédiaire d'un modèle (jamais copiée, jamais réinjectée) */
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'toolresult'; ok: boolean; preview: string }
  | { kind: 'escalate'; from: Target; to: Target; reason: string }
  | { kind: 'verify'; result: VerifyResult }
  | {
      kind: 'done';
      ok: boolean;
      target: Target | null;
      ms: number;
      tokens: number;
      costUsd: number;
      verified?: boolean;
      handoff: boolean;
      message?: string;
    }
  | { kind: 'info'; text: string }
  | { kind: 'warn'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'node'; node: ReactNode }
);

/** Item sans id (distributif : conserve chaque variante de l'union). */
export type NewItem = Item extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

export function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'welcome':
      return <Welcome {...item.props} />;
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={color.dim}>{'> '}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'route':
      return (
        <Box marginTop={1}>
          <RouteView decision={item.decision} dryRun={item.dryRun} />
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text>⏺ </Text>
          <Box flexShrink={1}>
            <Markdown text={item.text} />
          </Box>
        </Box>
      );
    case 'reasoning':
      return (
        <Box marginTop={1}>
          <Text color={color.dim}>💭 </Text>
          <Box flexShrink={1}>
            <Text color={color.dim} italic>
              {item.text}
            </Text>
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={color.ok}>⏺</Text> <Text bold>{item.name}</Text>
            <Text color={color.dim}>({item.summary})</Text>
          </Text>
        </Box>
      );
    case 'toolresult':
      return (
        <Text color={item.ok ? color.dim : color.err}>
          {'  ⎿ '}
          {item.preview || (item.ok ? 'ok' : 'erreur')}
        </Text>
      );
    case 'escalate':
      return (
        <Box marginTop={1}>
          <Text color={color.warn}>
            {t('⤴ Escalade ')}<Text bold>{item.from.label}</Text> → <Text bold>{item.to.label}</Text>
            <Text color={color.dim}> · {item.reason}</Text>
          </Text>
        </Box>
      );
    case 'verify':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={item.result.ok ? color.ok : color.err}>⏺</Text> <Text bold>{t('Vérification')}</Text>
          </Text>
          {item.result.steps.map((s, i) => (
            <Box key={i} flexDirection="column">
              <Text color={s.ok ? color.dim : color.err}>
                {'  ⎿ '}
                {s.ok ? '✔' : '✘'} {s.command} <Text color={color.dim}>({fmtDuration(s.ms)})</Text>
              </Text>
              {!s.ok
                ? s.output
                    .split('\n')
                    .slice(-8)
                    .map((l, j) => (
                      <Text key={j} color={color.dim}>
                        {'      '}
                        {l}
                      </Text>
                    ))
                : null}
            </Box>
          ))}
        </Box>
      );
    case 'done':
      return (
        <Box marginTop={1}>
          <Text color={item.ok ? color.ok : color.err}>
            {item.ok ? '✔' : '✘'} {item.target?.label ?? '—'}
            <Text color={color.dim}>
              {' '}
              · {fmtDuration(item.ms)}
              {item.tokens ? ` · ${fmtTokens(item.tokens)} tokens` : ''}
              {item.costUsd > 0 ? ` · ${item.costUsd.toFixed(3)} $` : ''}
              {item.verified ? t(' · vérifié') : ''}
              {item.handoff ? t(' · passation VS Code') : ''}
              {item.message ? ` · ${item.message}` : ''}
            </Text>
          </Text>
        </Box>
      );
    case 'info':
      return (
        <Box marginTop={1}>
          <Text color={color.dim}>{item.text}</Text>
        </Box>
      );
    case 'warn':
      return (
        <Box marginTop={1}>
          <Text color={color.warn}>⚠ {item.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={color.err}>✘ {item.text}</Text>
        </Box>
      );
    case 'node':
      return <Box marginTop={1}>{item.node}</Box>;
  }
}

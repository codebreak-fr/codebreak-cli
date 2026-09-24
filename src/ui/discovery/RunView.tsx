import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { runInstall, runRemove, type Plan, type RemovePlan, type RunResult } from '../../catalog/installer.js';
import { bar } from '../format.js';
import { Spinner } from '../Spinner.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

type OkInstall = Extract<Plan, { ok: true }>;
type OkRemove = Extract<RemovePlan, { ok: true }>;

/** Exécute l'installation (avec progression et annulation par `abort`) ou la suppression. */
export function RunView({
  op,
  plan,
  abort,
  onDone,
}: {
  op: 'install' | 'remove';
  plan: OkInstall | OkRemove;
  abort: AbortController;
  onDone: (r: RunResult) => void;
}) {
  const [percent, setPercent] = useState<number | undefined>();
  const [line, setLine] = useState('');
  const startedAt = useRef(Date.now());
  useEffect(() => {
    const run =
      op === 'install'
        ? runInstall(plan as OkInstall, { signal: abort.signal, onProgress: (p, text) => (p !== undefined && setPercent(p), text && setLine(text)) })
        : runRemove(plan as OkRemove);
    void run.then(onDone);
    // exécuté une seule fois par écran
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <Spinner label={op === 'install' ? t('Installation de {name}', { name: plan.name }) : t('Suppression de {name}', { name: plan.name })} startedAt={startedAt.current} />
      {percent !== undefined ? (
        <Text>
          <Text color={color.brand}>{bar(percent / 100, 30)}</Text> {percent} %
        </Text>
      ) : null}
      {line ? (
        <Box>
          <Text color={color.dim} wrap="truncate-end">{line}</Text>
        </Box>
      ) : null}
    </>
  );
}

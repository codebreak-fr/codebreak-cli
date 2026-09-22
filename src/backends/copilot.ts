import { exec, sleep, truncate } from '../util/exec.js';
import type { RunEvent } from '../types.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

/** Copilot n'a pas d'API en ligne de commande : on ouvre le chat de VS Code (mode agent) avec le prompt. */
export async function* runCopilot(req: RunRequest): AsyncGenerator<RunEvent> {
  const { prompt, cwd, cfg, det } = req;
  const code = det.copilot.path ?? 'code';
  if (cfg.copilot.open_folder) {
    await exec(code, [cwd], { timeoutMs: 15_000 });
    await sleep(1200);
  }
  const r = await exec(code, ['chat', '-m', cfg.copilot.mode, '-r', prompt], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) {
    const msg = r.stderr || t('code chat a échoué');
    const quota = /quota|exhausted|premium|allowance|rate.?limit/i.test(msg);
    yield { type: 'error', kind: quota ? 'quota' : 'unavailable', message: truncate(msg, 300) };
    return;
  }
  yield {
    type: 'handoff',
    message: t('Prompt envoyé à Copilot Chat (mode {mode}) dans VS Code — la suite se passe dans l’éditeur.', { mode: cfg.copilot.mode }),
  };
}

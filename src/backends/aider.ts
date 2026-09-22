import { exec, truncate } from '../util/exec.js';
import type { RunEvent } from '../types.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** Nettoie la sortie d’aider (couleurs, retours chariot) pour l’afficher telle quelle. */
export function cleanAiderOutput(raw: string): string {
  return raw
    .replace(/\r/g, '\n')
    .replace(ANSI, '')
    .split('\n')
    .filter((l) => l.trim() && !/^\s*$/.test(l))
    .join('\n')
    .trim();
}

export async function* runAider(req: RunRequest): AsyncGenerator<RunEvent> {
  const { prompt, cwd, signal, cfg, det, target } = req;
  const bin = det.aider.path ?? 'aider';
  const args = [
    '--message',
    prompt,
    '--yes',
    '--no-pretty',
    '--no-fancy-input',
    '--no-show-release-notes',
    '--no-suggest-shell-commands',
    '--no-check-update',
    ...(cfg.aider.auto_commits ? [] : ['--no-auto-commits']),
    ...(target.model && target.model !== 'default' ? ['--model', target.model] : []),
    ...cfg.aider.extra_args,
  ];
  let r;
  try {
    r = await exec(bin, args, { cwd, signal, timeoutMs: 600_000 });
  } catch (e) {
    yield { type: 'error', kind: 'crash', message: (e as Error).message };
    return;
  }
  const text = cleanAiderOutput(r.stdout);
  if (r.code !== 0 && !text) {
    const msg = r.stderr || t('aider a quitté avec le code {code}', { code: r.code });
    const quota = /rate|limit|quota|credit|billing|402/i.test(msg);
    yield { type: 'error', kind: quota ? 'quota' : 'crash', message: truncate(msg, 300) };
    return;
  }
  if (text) yield { type: 'text', text: truncate(text, 20_000) };
  else yield { type: 'error', kind: 'crash', message: t('aider n’a produit aucune réponse') };
}

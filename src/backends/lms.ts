import { ensureLmsRunning } from '../detect/backends.js';
import type { RunEvent } from '../types.js';
import { openAiChat } from './openai-compat.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

const SYSTEM = 'You are a concise, precise software development assistant. Reply in the user\'s language.';

export async function* runLms(req: RunRequest): AsyncGenerator<RunEvent> {
  const { cfg, det, target } = req;
  if (!det.lms.running && !(await ensureLmsRunning(cfg, det.lms.path ?? 'lms', cfg.lms.base_url))) {
    yield { type: 'error', kind: 'unavailable', message: t('serveur LM Studio injoignable (`lms server start`).') };
    return;
  }
  yield* openAiChat({
    baseUrl: cfg.lms.base_url,
    model: target.model,
    prompt: req.prompt,
    system: SYSTEM,
    temperature: cfg.lms.temperature,
    maxTokens: cfg.lms.max_tokens,
    signal: req.signal,
  });
}

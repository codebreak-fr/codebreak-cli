import { existsSync } from 'node:fs';
import { streamLines, truncate } from '../util/exec.js';
import type { RunEvent } from '../types.js';
import { openAiChat } from './openai-compat.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

const SYSTEM = 'You are a concise, precise software development assistant. Reply in the user\'s language.';

export async function* runLlamacpp(req: RunRequest): AsyncGenerator<RunEvent> {
  const { cfg, det, target } = req;
  const known = det.llamacpp.models.find((m) => m.id === target.model);

  // 1) un serveur llama-server en marche sert déjà le modèle → API OpenAI
  if (det.llamacpp.runningServer && known?.loaded) {
    yield* openAiChat({
      baseUrl: cfg.llamacpp.base_url,
      model: target.model,
      prompt: req.prompt,
      system: SYSTEM,
      temperature: cfg.llamacpp.temperature,
      signal: req.signal,
    });
    return;
  }

  // 2) sinon, génération ponctuelle avec llama-cli sur le fichier GGUF
  const bin = det.llamacpp.cliPath;
  const modelPath = known?.path ?? target.model;
  if (!bin || !existsSync(modelPath)) {
    yield {
      type: 'error',
      kind: 'unavailable',
      message: t('llama.cpp : ni serveur pour « {model} » ni fichier GGUF ({modelPath}).', { model: target.model, modelPath }),
    };
    return;
  }
  const args = [
    '-m',
    modelPath,
    '-p',
    req.prompt,
    '-n',
    String(cfg.llamacpp.n_predict),
    '-c',
    String(cfg.llamacpp.num_ctx),
    '--temp',
    String(cfg.llamacpp.temperature),
    '--no-display-prompt',
    '--simple-io',
    '-st',
    ...cfg.llamacpp.extra_args,
  ];
  const gen = streamLines(bin, args, { cwd: req.cwd, signal: req.signal });
  let produced = false;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      const { code, stderr } = value;
      if (!produced || code !== 0) {
        yield { type: 'error', kind: 'crash', message: truncate(stderr || t('llama-cli a quitté avec le code {code}', { code }), 300) };
      }
      return;
    }
    if (value.trim()) {
      produced = true;
      yield { type: 'text', text: value, delta: true };
      yield { type: 'text', text: '\n', delta: true };
    }
  }
}

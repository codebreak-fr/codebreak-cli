import type { Config } from '../config/schema.js';
import { VARIANT_PREFIX } from '../detect/backends.js';
import { ensureOllamaRunning } from '../detect/ollama-server.js';
import type { RunEvent } from '../types.js';
import { runOpencode } from './opencode.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

const variantName = (model: string, ctx: number) =>
  `${VARIANT_PREFIX}${model.replace(/[^a-z0-9.-]+/gi, '-')}:ctx${Math.round(ctx / 1024)}k`;

/**
 * Le mode agent (OpenCode) envoie ~8 000 tokens de consignes : le contexte par défaut d'Ollama (4k) est trop court.
 * On crée donc une variante du modèle (aucune copie de poids) avec un num_ctx plus grand.
 */
export async function ensureAgentVariant(cfg: Config, model: string): Promise<string> {
  const name = variantName(model, cfg.ollama.agent_num_ctx);
  try {
    const tags = (await (await fetch(`${cfg.ollama.base_url}/api/tags`)).json()) as { models: { name: string }[] };
    if (tags.models.some((m) => m.name === name)) return name;
    const r = await fetch(`${cfg.ollama.base_url}/api/create`, {
      method: 'POST',
      body: JSON.stringify({ model: name, from: model, parameters: { num_ctx: cfg.ollama.agent_num_ctx }, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    return r.ok ? name : model;
  } catch {
    return model;
  }
}

export async function* runOllama(req: RunRequest): AsyncGenerator<RunEvent> {
  const { cfg, det, target } = req;
  if (!(await ensureOllamaRunning(cfg, det.ollama.path))) {
    yield { type: 'error', kind: 'unavailable', message: t('Ollama ne répond pas (démarre-le avec `ollama serve`).') };
    return;
  }
  if (req.needsTools !== false && target.caps.tools && det.opencode.installed) yield* runOllamaAgent(req);
  else yield* runOllamaChat(req);
}

async function* runOllamaAgent(req: RunRequest): AsyncGenerator<RunEvent> {
  const { cfg, target } = req;
  const model = await ensureAgentVariant(cfg, target.model);
  const config = {
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL: `${cfg.ollama.base_url}/v1` },
        models: { [model]: { name: model } },
      },
    },
  };
  yield* runOpencode(req, { model: `ollama/${model}`, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } });
}

const CHAT_SYSTEM =
  'You are a concise, precise software development assistant. Reply in the user\'s language. Give complete code when asked.';

async function* runOllamaChat(req: RunRequest): AsyncGenerator<RunEvent> {
  const { cfg, target, prompt, signal } = req;
  let res: Response;
  try {
    res = await fetch(`${cfg.ollama.base_url}/api/chat`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: target.model,
        stream: true,
        keep_alive: cfg.ollama.keep_alive,
        options: { num_ctx: cfg.ollama.chat_num_ctx },
        messages: [
          { role: 'system', content: CHAT_SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (e) {
    yield { type: 'error', kind: 'crash', message: String((e as Error).message) };
    return;
  }
  if (!res.ok || !res.body) {
    yield { type: 'error', kind: 'crash', message: `Ollama HTTP ${res.status}` };
    return;
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        eval_duration?: number;
        error?: string;
      };
      if (ev.error) {
        yield { type: 'error', kind: 'crash', message: ev.error };
        return;
      }
      if (ev.message?.content) yield { type: 'text', text: ev.message.content, delta: true };
      if (ev.done) {
        yield {
          type: 'usage',
          inputTokens: ev.prompt_eval_count ?? 0,
          outputTokens: ev.eval_count ?? 0,
          tokensPerSec: ev.eval_duration ? (ev.eval_count ?? 0) / (ev.eval_duration / 1e9) : undefined,
        };
      }
    }
  }
}

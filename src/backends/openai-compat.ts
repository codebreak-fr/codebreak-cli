import type { RunEvent } from '../types.js';
import { t } from '../i18n/index.js';

export interface OpenAiChatOptions {
  baseUrl: string;
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
}

/**
 * Chat en flux sur un serveur local OpenAI-compatible (LM Studio, llama-server).
 * Émet des `text` en delta et l’usage quand le serveur le fournit.
 */
export async function* openAiChat(opts: OpenAiChatOptions): AsyncGenerator<RunEvent> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        // sans ça, la plupart des serveurs OpenAI-compatibles n'envoient aucun usage en streaming
        stream_options: { include_usage: true },
        temperature: opts.temperature ?? 0.2,
        ...(opts.maxTokens && opts.maxTokens > 0 ? { max_tokens: opts.maxTokens } : {}),
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: opts.prompt },
        ],
      }),
    });
  } catch (e) {
    yield { type: 'error', kind: 'unavailable', message: t('serveur local injoignable ({baseUrl}) : {message}', { baseUrl: opts.baseUrl, message: (e as Error).message }) };
    return;
  }
  if (!res.ok || !res.body) {
    yield { type: 'error', kind: 'crash', message: t('réponse HTTP {status} de {baseUrl}', { status: res.status, baseUrl: opts.baseUrl }) };
    return;
  }

  const decoder = new TextDecoder();
  let buf = '';
  let produced = false;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev: { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.error) {
        yield { type: 'error', kind: 'crash', message: ev.error.message ?? t('erreur du serveur local') };
        return;
      }
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) {
        produced = true;
        yield { type: 'text', text: delta, delta: true };
      }
      if (ev.usage) {
        yield { type: 'usage', inputTokens: ev.usage.prompt_tokens ?? 0, outputTokens: ev.usage.completion_tokens ?? 0 };
      }
    }
  }
  if (!produced) yield { type: 'error', kind: 'crash', message: t('réponse vide du serveur local') };
}

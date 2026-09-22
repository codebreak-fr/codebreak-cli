import { describe, expect, it, vi, afterEach } from 'vitest';
import { mapGeminiEvent, geminiErrorHint } from '../src/backends/gemini.js';
import { mapVibeEntry, vibeErrorHint } from '../src/backends/vibe.js';
import { mapOpencodeEvent } from '../src/backends/opencode.js';
import { openAiChat } from '../src/backends/openai-compat.js';
import { ConfigSchema } from '../src/config/schema.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('réflexion OpenCode (--thinking)', () => {
  it('opencode.thinking vaut true par défaut', () => {
    expect(ConfigSchema.parse({}).opencode.thinking).toBe(true);
  });

  it('un événement reasoning devient un RunEvent reasoning (jamais du texte final)', () => {
    const seen = {};
    const out = [
      ...mapOpencodeEvent(
        { type: 'reasoning', sessionID: 's1', part: { type: 'reasoning', text: 'je réfléchis en français' } },
        seen,
      ),
    ];
    expect(out).toEqual([
      { type: 'session', id: 's1' },
      { type: 'reasoning', text: 'je réfléchis en français' },
    ]);
  });

  it('texte vide ou absent ignoré', () => {
    expect([...mapOpencodeEvent({ type: 'reasoning', part: { type: 'reasoning', text: '  ' } }, {})]).toEqual([]);
  });
});

describe('usage tolérant (tous les LLM)', () => {
  it('Gemini accepte stats et usage, snake et camel', () => {
    const seen = {};
    expect([...mapGeminiEvent({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 } }, seen)]).toMatchObject([
      { type: 'usage', inputTokens: 10, outputTokens: 2 },
    ]);
    const seen2 = {};
    expect([...mapGeminiEvent({ type: 'result', status: 'success', usage: { inputTokens: 7, outputTokens: 3 } }, seen2)]).toMatchObject([
      { type: 'usage', inputTokens: 7, outputTokens: 3 },
    ]);
  });

  it('Gemini 503/surcharge → quota + conseil modèle', () => {
    const out = [...mapGeminiEvent({ type: 'result', status: 'error', error: { message: '503 high demand UNAVAILABLE' }, stats: {} }, {})];
    const err = out.find((e) => e.type === 'error');
    expect(err).toMatchObject({ kind: 'quota' });
    expect((err as { message: string }).message).toMatch(/saturé/);
    expect(geminiErrorHint('boom')).toBe('boom');
  });

  it('Vibe capte la session en camelCase (sessionId) comme en snake_case', () => {
    const seen: { sessionId?: string } = {};
    const out = [...mapVibeEntry({ sessionId: 'abc', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, seen)];
    expect(seen.sessionId).toBe('abc');
    expect(out.map((e) => e.type)).toEqual(['session', 'text']);
  });

  it('Vibe 402 → quota + conseil abonnement', () => {
    const out = [...mapVibeEntry({ type: 'error', message: '402 Payment Required' }, {})];
    expect(out[0]).toMatchObject({ type: 'error', kind: 'quota' });
    expect((out[0] as { message: string }).message).toMatch(/abonnement Mistral/);
    expect(vibeErrorHint('autre')).toBe('autre');
  });

  it('Vibe usage/stats → tokens tracés dans le ledger', () => {
    const out = [...mapVibeEntry({ type: 'usage', input_tokens: 100, output_tokens: 20 }, {})];
    expect(out).toMatchObject([{ type: 'usage', inputTokens: 100, outputTokens: 20 }]);
  });

  it('LM Studio / llama-server : demande include_usage en streaming', async () => {
    const enc = new TextEncoder();
    let captured: string | undefined;
    const fakeBody = (async function* () {
      yield enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
      yield enc.encode('data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n');
      yield enc.encode('data: [DONE]\n');
    })();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: unknown) => {
        captured = (init as { body?: string }).body;
        return { ok: true, body: fakeBody };
      }),
    );
    const events = [];
    const ac = new AbortController();
    for await (const e of openAiChat({ baseUrl: 'http://localhost:1234', model: 'm', prompt: 'hi', signal: ac.signal })) {
      events.push(e);
    }
    expect(JSON.parse(captured!).stream_options).toEqual({ include_usage: true });
    expect(events).toMatchObject([
      { type: 'text', text: 'hi' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
  });
});

import { streamLines, truncate } from '../util/exec.js';
import type { RunEvent } from '../types.js';
import { summarizeTool } from './claude.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

/** Événements `opencode run --format json` → RunEvent. */
export function* mapOpencodeEvent(ev: Record<string, any>, seen: { sessionId?: string }): Generator<RunEvent> {
  if (ev.sessionID && ev.sessionID !== seen.sessionId) {
    seen.sessionId = ev.sessionID;
    yield { type: 'session', id: ev.sessionID };
  }
  const part = ev.part ?? {};
  switch (ev.type) {
    case 'text':
      if (part.text?.trim()) yield { type: 'text', text: part.text };
      break;
    case 'reasoning':
    case 'thought':
    case 'thinking':
      if (typeof part.text === 'string' && part.text.trim()) yield { type: 'reasoning', text: part.text };
      break;
    case 'tool_use': {
      const st = part.state ?? {};
      const id = part.callID ?? part.id ?? String(Math.random());
      yield { type: 'tool', id, name: part.tool ?? 'tool', summary: st.title ? truncate(st.title, 90) : summarizeTool(part.tool, st.input) };
      if (st.status === 'completed' || st.status === 'error') {
        yield { type: 'tool_result', id, ok: st.status === 'completed', preview: truncate(String(st.output ?? st.error ?? ''), 160) };
      }
      break;
    }
    case 'error': {
      const msg = ev.error?.data?.message ?? ev.error?.message ?? JSON.stringify(ev.error ?? ev);
      const quota = /rate|limit|quota|credit/i.test(msg);
      yield { type: 'error', kind: quota ? 'quota' : 'crash', message: truncate(String(msg), 300) };
      break;
    }
  }
}

export interface OpencodeOptions {
  model: string;
  env?: NodeJS.ProcessEnv;
}

export async function* runOpencode(req: RunRequest, opts: OpencodeOptions): AsyncGenerator<RunEvent> {
  const { prompt, cwd, signal, sessionId, cfg, det } = req;
  const bin = det.opencode.path ?? 'opencode';
  const args = [
    'run',
    '-m',
    opts.model,
    '--format',
    'json',
    ...(cfg.opencode.thinking ? ['--thinking'] : []),
    ...(sessionId ? ['-s', sessionId] : []),
    prompt,
  ];
  // Permissions par variable d'environnement : sans flag, une version d'OpenCode qui ne le connaît pas ne plante pas.
  const permission = cfg.opencode.auto_approve ? { OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow' }) } : {};
  const gen = streamLines(bin, args, { cwd, signal, env: { ...process.env, ...permission, ...opts.env } });
  const seen: { sessionId?: string } = {};
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let produced = false;
  let errored = false;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      const { code, stderr } = value;
      if (inTok || outTok) yield { type: 'usage', inputTokens: inTok, outputTokens: outTok, costUsd: cost || undefined };
      if (!errored && (code !== 0 || !produced)) {
        yield { type: 'error', kind: 'crash', message: truncate(stderr || t('opencode a quitté avec le code {code}', { code }), 300) };
      }
      return;
    }
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(value);
    } catch {
      continue;
    }
    if (ev.type === 'step_finish') {
      const t = ev.part?.tokens ?? {};
      inTok += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      outTok += (t.output ?? 0) + (t.reasoning ?? 0);
      cost += ev.part?.cost ?? 0;
    }
    for (const out of mapOpencodeEvent(ev, seen)) {
      if (out.type === 'text' || out.type === 'tool' || out.type === 'reasoning') produced = true;
      if (out.type === 'error') errored = true;
      yield out;
    }
  }
}

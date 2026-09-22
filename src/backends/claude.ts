import { contextDir } from '../exec/context.js';
import { parseRateLimitEvent, saveUsage } from '../usage/claude.js';
import { streamLines, truncate } from '../util/exec.js';
import type { RunEvent } from '../types.js';
import type { Adapter } from './types.js';
import { t } from '../i18n/index.js';

export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const pick = (...keys: string[]) => keys.map((k) => i[k]).find((v) => typeof v === 'string') as string | undefined;
  const main =
    pick('command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description', 'prompt') ??
    JSON.stringify(i);
  return truncate(main, 90);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  }
  return '';
}

/** Événements `claude -p --output-format stream-json` → RunEvent. */
export function* mapClaudeEvent(ev: Record<string, any>): Generator<RunEvent> {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init' && ev.session_id) yield { type: 'session', id: ev.session_id };
      break;
    case 'assistant':
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text) yield { type: 'text', text: block.text };
        if (block.type === 'tool_use') {
          yield { type: 'tool', id: block.id, name: block.name, summary: summarizeTool(block.name, block.input) };
        }
      }
      break;
    case 'user':
      for (const block of ev.message?.content ?? []) {
        if (block?.type === 'tool_result') {
          yield {
            type: 'tool_result',
            id: block.tool_use_id,
            ok: !block.is_error,
            preview: truncate(resultText(block.content), 160),
          };
        }
      }
      break;
    case 'rate_limit_event': {
      const patch = parseRateLimitEvent(ev as never);
      if (patch) {
        saveUsage(patch);
        yield { type: 'rate', usage: patch };
      }
      break;
    }
    case 'result': {
      const u = ev.usage ?? {};
      yield {
        type: 'usage',
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        costUsd: ev.total_cost_usd,
      };
      if (ev.is_error) {
        const msg = String(ev.result ?? ev.subtype ?? t('erreur Claude'));
        const quota = /limit|quota|usage|rate/i.test(msg);
        if (quota) saveUsage({ status: 'rejected' });
        yield { type: 'error', kind: quota ? 'quota' : 'crash', message: truncate(msg, 300) };
      }
      break;
    }
  }
}

export const runClaude: Adapter = async function* ({ prompt, cwd, target, signal, sessionId, cfg, det }) {
  const bin = det.claude.path ?? 'claude';
  const dirs = [contextDir(cwd, cfg), ...cfg.claude.add_dirs].filter(Boolean);
  const args = [
    '-p',
    '--model',
    target.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    cfg.claude.permission_mode,
    ...(cfg.claude.allowed_tools.length ? ['--allowedTools', cfg.claude.allowed_tools.join(',')] : []),
    ...dirs.flatMap((d) => ['--add-dir', d]),
    ...(sessionId ? ['--resume', sessionId] : []),
    ...cfg.claude.extra_args,
  ];
  const gen = streamLines(bin, args, { cwd, input: prompt, signal });
  let sawResult = false;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      const { code, stderr } = value;
      if (!sawResult && code !== 0) {
        const quota = /limit|quota/i.test(stderr);
        yield { type: 'error', kind: quota ? 'quota' : 'crash', message: truncate(stderr || t('claude a quitté avec le code {code}', { code }), 300) };
      }
      return;
    }
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(value);
    } catch {
      continue;
    }
    if (ev.type === 'result') sawResult = true;
    yield* mapClaudeEvent(ev);
  }
};

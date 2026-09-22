import { summarizeTool } from './claude.js';
import { streamLines, truncate } from '../util/exec.js';
import { contextDir } from '../exec/context.js';
import type { RunEvent } from '../types.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

/** 429/503/surcharge : le modèle est saturé ou le quota est atteint → escalade, pas un bug. */
const QUOTA_RE = /rate|limit|quota|credit|billing|402|403|429|500|502|503|resource_exhausted|unavailable|overload|high demand|too many requests/i;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Les noms de champs varient selon les versions (`stats` vs `usage`, snake vs camel). */
function extractUsage(ev: Record<string, any>): { inputTokens: number; outputTokens: number } | null {
  const s = ev.stats ?? ev.usage ?? ev.token_count ?? ev.tokens;
  if (!s || typeof s !== 'object') return null;
  const input = num(s.input_tokens) ?? num(s.inputTokens) ?? num(s.prompt_tokens) ?? num(s.promptTokens) ?? 0;
  const output = num(s.output_tokens) ?? num(s.outputTokens) ?? num(s.candidates_tokens) ?? num(s.completion_tokens) ?? num(s.completionTokens) ?? 0;
  return input || output ? { inputTokens: input, outputTokens: output } : null;
}

/** Message d'erreur enrichi d'un conseil quand la cause est connue (surcharge, auth). */
export function geminiErrorHint(msg: string): string {
  if (/503|unavailable|overload|high demand/i.test(msg)) {
    return t('{v} — modèle saturé : réessaie plus tard ou change de modèle (/models gemini <modèle>)', { v: truncate(msg, 200) });
  }
  if (/401|403|unauthorized|forbidden|api.?key|auth/i.test(msg)) {
    return t('{v} — vérifie l’authentification Gemini (clé API ou compte Google)', { v: truncate(msg, 200) });
  }
  return msg;
}
/** Événements `gemini --output-format stream-json` → RunEvent. */
export function* mapGeminiEvent(ev: Record<string, any>, seen: { sessionId?: string }): Generator<RunEvent> {
  switch (ev.type) {
    case 'init':
      if (ev.session_id && ev.session_id !== seen.sessionId) {
        seen.sessionId = ev.session_id;
        yield { type: 'session', id: ev.session_id };
      }
      break;
    case 'message':
      if (ev.role === 'assistant' && typeof ev.content === 'string' && ev.content.trim()) {
        yield { type: 'text', text: ev.content, delta: ev.delta === true ? true : undefined };
      }
      break;
    case 'tool_use': {
      const id = ev.tool_id ?? String(Math.random());
      yield { type: 'tool', id, name: ev.tool_name ?? 'tool', summary: summarizeTool(ev.tool_name, ev.parameters) };
      break;
    }
    case 'tool_result':
      yield {
        type: 'tool_result',
        id: ev.tool_id ?? '',
        ok: ev.status !== 'error',
        preview: truncate(String(ev.output ?? ev.error ?? ''), 160),
      };
      break;
    case 'error': {
      const raw = String(ev.message ?? ev.error ?? t('erreur Gemini'));
      const msg = geminiErrorHint(raw);
      yield { type: 'error', kind: QUOTA_RE.test(raw) ? 'quota' : 'crash', message: truncate(msg, 300) };
      break;
    }
    case 'result': {
      const u = extractUsage(ev);
      if (u) yield { type: 'usage', inputTokens: u.inputTokens, outputTokens: u.outputTokens };
      if (ev.status && ev.status !== 'success') {
        const raw = String(ev.error?.message ?? t('Gemini s’est terminé avec le statut {status}', { status: ev.status }));
        yield { type: 'error', kind: QUOTA_RE.test(raw) ? 'quota' : 'crash', message: truncate(geminiErrorHint(raw), 300) };
      }
      break;
    }
  }
}

export async function* runGemini(req: RunRequest): AsyncGenerator<RunEvent> {
  const { prompt, cwd, signal, cfg, det, target } = req;
  const bin = det.gemini.path ?? 'gemini';
  const ctxDir = contextDir(cwd, cfg);
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--approval-mode',
    cfg.gemini.approval_mode,
    '--skip-trust',
    ...(ctxDir ? ['--include-directories', ctxDir] : []),
    ...(target.model && target.model !== 'auto' ? ['-m', target.model] : []),
    ...cfg.gemini.extra_args,
  ];
  const gen = streamLines(bin, args, { cwd, signal });
  const seen: { sessionId?: string } = {};
  let sawResult = false;
  let produced = false;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      const { code, stderr } = value;
      if (!sawResult && (code !== 0 || !produced)) {
        const raw = (stderr || t('gemini a quitté avec le code {code}', { code })).trim();
        yield { type: 'error', kind: QUOTA_RE.test(raw) ? 'quota' : 'crash', message: truncate(geminiErrorHint(raw), 300) };
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
    for (const out of mapGeminiEvent(ev, seen)) {
      if (out.type === 'text' || out.type === 'tool') produced = true;
      yield out;
    }
  }
}

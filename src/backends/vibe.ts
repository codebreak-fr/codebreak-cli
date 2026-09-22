import { streamLines, truncate } from '../util/exec.js';
import type { RunEvent } from '../types.js';
import type { RunRequest } from './types.js';
import { t } from '../i18n/index.js';

interface VibeBlock {
  type?: string;
  text?: string;
}

/** 402 = pas d'abonnement Mistral payant → escalade avec un message explicite, pas un bug. */
const VIBE_QUOTA_RE = /402|payment|quota|rate|limit|subscription|plan/i;

const vibeNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Les champs d'usage varient selon les versions ; on accepte toutes les variantes connues. */
function extractVibeUsage(ev: Record<string, any>): { inputTokens: number; outputTokens: number; costUsd?: number } | null {
  const s = ev.usage ?? ev.stats ?? ev.tokens ?? ev.token_usage ?? ev;
  if (!s || typeof s !== 'object') return null;
  const input =
    vibeNum(s.input_tokens) ?? vibeNum(s.inputTokens) ?? vibeNum(s.prompt_tokens) ?? vibeNum(s.promptTokens) ?? 0;
  const output =
    vibeNum(s.output_tokens) ?? vibeNum(s.outputTokens) ?? vibeNum(s.completion_tokens) ?? vibeNum(s.completionTokens) ?? 0;
  const cost =
    vibeNum(s.cost) ?? vibeNum(s.price) ?? vibeNum(s.total_cost) ?? vibeNum(s.cost_usd) ?? vibeNum(s.costUsd);
  if (!input && !output && cost === undefined) return null;
  return { inputTokens: input, outputTokens: output, costUsd: cost };
}

/** Entrées `vibe -p … --output streaming` (JSON par ligne) → RunEvent. */
export function* mapVibeEntry(ev: Record<string, any>, seen: { sessionId?: string }): Generator<RunEvent> {
  const sid = ev.session_id ?? ev.sessionId;
  if (sid && sid !== seen.sessionId) {
    seen.sessionId = sid;
    yield { type: 'session', id: sid };
  }
  if ((ev.type === 'usage' || ev.type === 'result' || ev.type === 'stats' || ev.type === 'summary') && !ev.role) {
    const u = extractVibeUsage(ev);
    if (u) {
      yield { type: 'usage', inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd };
      return;
    }
  }
  if (ev.type === 'message' && ev.role === 'assistant') {
    const blocks = ((ev.content ?? []) as VibeBlock[]);
    const thought = blocks
      .filter((b) => (b.type === 'reasoning' || b.type === 'thinking' || b.type === 'thought') && b.text)
      .map((b) => b.text)
      .join('');
    if (thought.trim()) yield { type: 'reasoning', text: thought };
    const text = blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
    if (text.trim()) yield { type: 'text', text };
    return;
  }
  if (ev.type === 'effect') {
    const state = ev.state ?? {};
    const id = String(ev.id ?? Math.random());
    const name = ev.detail?.kind ?? 'outil';
    yield { type: 'tool', id, name, summary: truncate(String(ev.title ?? name), 90) };
    if (state.status && state.status !== 'running' && state.status !== 'pending' && state.status !== 'blocked') {
      yield {
        type: 'tool_result',
        id,
        ok: state.status === 'completed',
        preview: truncate(String(state.output_text ?? ''), 160),
      };
    }
    return;
  }
  if (ev.type === 'error') {
    const raw = String(ev.message ?? ev.error ?? ev.provider_message ?? t('erreur Vibe'));
    yield { type: 'error', kind: VIBE_QUOTA_RE.test(raw) ? 'quota' : 'crash', message: truncate(vibeErrorHint(raw), 300) };
  }
}

/** Message d'erreur enrichi : un 402 signifie simplement qu'il n'y a pas d'abonnement Mistral payant. */
export function vibeErrorHint(msg: string): string {
  if (/402|payment required|subscription/i.test(msg)) {
    return t('{v} — Vibe exige un abonnement Mistral payant (/tools off vibe pour l’exclure, ou https://admin.mistral.ai/subscription)', { v: truncate(msg, 200) });
  }
  return msg;
}

export async function* runVibe(req: RunRequest): AsyncGenerator<RunEvent> {
  const { prompt, cwd, signal, cfg, det } = req;
  const bin = det.vibe.path ?? 'vibe';
  const args = [
    '-p',
    prompt,
    '--output',
    'streaming',
    '--agent',
    cfg.vibe.agent,
    ...(cfg.vibe.trust ? ['--trust'] : []),
    ...cfg.vibe.extra_args,
  ];
  const gen = streamLines(bin, args, { cwd, signal });
  const seen: { sessionId?: string } = {};
  let produced = false;
  let errored = false;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      const { code, stderr } = value;
      if (!errored && (code !== 0 || !produced)) {
        const raw = (stderr || t('vibe a quitté avec le code {code}', { code })).trim();
        yield { type: 'error', kind: VIBE_QUOTA_RE.test(raw) ? 'quota' : 'crash', message: truncate(vibeErrorHint(raw), 300) };
      }
      return;
    }
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(value);
    } catch {
      continue;
    }
    for (const out of mapVibeEntry(ev, seen)) {
      if (out.type === 'text' || out.type === 'tool' || out.type === 'reasoning') produced = true;
      if (out.type === 'error') errored = true;
      yield out;
    }
  }
}

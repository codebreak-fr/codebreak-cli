import { ALL_BACKENDS, CONFIGURABLE_BACKENDS } from '../router/targets.js';
import type { BackendId } from '../types.js';
import { t } from '../i18n/index.js';

/** Alias acceptés à la place de l'identifiant interne d'un outil. */
const BACKEND_ALIASES: Record<string, BackendId> = { llama: 'llamacpp', lmstudio: 'lms', free: 'opencode', vscode: 'copilot' };

export const normalizeBackend = (s: string): BackendId | undefined => {
  const id = (BACKEND_ALIASES[s.toLowerCase()] ?? s.toLowerCase()) as BackendId;
  return ALL_BACKENDS.some((b) => b.id === id) ? id : undefined;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ---- `tools` : on|off <outil…> · reset (la liste interactive / non interactive est gérée par l'appelant) ----

export interface ToolsChange {
  mode: 'on' | 'off' | 'reset';
  ids: BackendId[];
}

export function parseToolsArgs(rest: string[]): ParseResult<ToolsChange> {
  const [mode, ...names] = rest.map((r) => r.toLowerCase());
  if (mode === 'reset') return { ok: true, value: { mode: 'reset', ids: ALL_BACKENDS.map((b) => b.id) } };
  if (mode !== 'on' && mode !== 'off') return { ok: false, error: t('Usage : tools on|off <outil…> · tools reset') };
  const bad = names.filter((n) => !normalizeBackend(n));
  if (bad.length || !names.length) {
    return { ok: false, error: t('Outil inconnu : {v}. Essaie {v2} (ou llama, lmstudio, free).', { v: bad.join(', ') || '(aucun)', v2: ALL_BACKENDS.map((b) => b.id).join(', ') }) };
  }
  return { ok: true, value: { mode, ids: [...new Set(names.map((n) => normalizeBackend(n)!))] } };
}

export const toolsWrites = (c: ToolsChange): [string, unknown][] => c.ids.map((id) => [`${id}.enabled`, c.mode !== 'off']);

export const describeToolsChange = (c: ToolsChange) => t('Outils → {v}', { v: c.ids.map((id) => `${id} ${c.mode === 'off' ? 'off' : 'on'}`).join(', ') });

// ---- `models <ia> [<modèle>]` : modèle par défaut d'une IA ----

export interface ModelArgs {
  backend?: BackendId;
  model: string;
}

export function parseModelArgs(rest: string[]): ParseResult<ModelArgs> {
  const [backendArg, ...modelParts] = rest;
  if (!backendArg) return { ok: true, value: { model: '' } };
  const backend = normalizeBackend(backendArg);
  if (!backend || !CONFIGURABLE_BACKENDS.includes(backend)) {
    return { ok: false, error: t('IA inconnue ou sans modèle configurable : {backendArg}. Essaie {v} (ou llama, lmstudio, free).', { backendArg, v: CONFIGURABLE_BACKENDS.join(', ') }) };
  }
  return { ok: true, value: { backend, model: modelParts.join(' ') } };
}

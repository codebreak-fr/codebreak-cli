import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { MemoryPaths } from './layout.js';
import { redact } from '../util/redact.js';

export type TaskStatus = 'queued' | 'implementing' | 'verifying' | 'escalating' | 'done' | 'failed' | 'aborted' | 'handoff';

export interface VerifyRecord {
  command: string;
  ok: boolean;
  exitCode?: number | null;
  ms: number;
  timedOut?: boolean;
}

export interface FailureRecord {
  kind: string;
  fingerprint: string;
  summary: string;
  command?: string;
}

export interface AttemptRecord {
  n: number;
  target: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  filesChanged: string[];
  snapshotBefore?: string;
  snapshotAfter?: string;
  verify?: VerifyRecord[];
  failure?: FailureRecord;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** décision prise après cette tentative */
  next?: { action: 'retry' | 'escalate' | 'stop' | 'done'; reason: string; to?: string };
}

export interface TaskManifest {
  id: string;
  task: string;
  status: TaskStatus;
  created: string;
  updated: string;
  cwd: string;
  budget: { max_attempts: number; max_minutes: number; max_cost_usd: number };
  /** cibles autorisées, dans l'ordre d'escalade prévu */
  escalation: string[];
  allowed_agents: string[];
  files: string[];
  context?: { files: number; decisions: number; failures: number; chars: number };
  attempts: AttemptRecord[];
  /** objectif complet (corps du fichier) */
  objective: string;
  notes: string;
}

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

export const manifestPath = (p: Pick<MemoryPaths, 'tasksDir'>, id: string) => join(p.tasksDir, `${id}.md`);

export const titleOf = (prompt: string) => prompt.split('\n').find((l) => l.trim())?.trim().slice(0, 90) ?? '(empty)';

export function serializeManifest(m: TaskManifest): string {
  const { objective, notes, ...front } = m;
  // le fichier entier est masqué : un résumé d'échec ou un chemin peut contenir un secret
  return redact(
    `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n\n# ${m.task}\n\n## Objective\n${objective.trim()}\n\n## Notes\n${notes.trim() || '_Your notes. CodeBreak never overwrites this section._'}\n`,
  );
}

export function parseManifest(text: string): TaskManifest | null {
  const m = FRONT.exec(text);
  if (!m) return null;
  try {
    const front = parse(m[1]!) as Partial<TaskManifest>;
    if (!front || typeof front.id !== 'string') return null;
    const body = text.slice(m[0].length);
    const objective = /## Objective\n([\s\S]*?)\n## Notes/.exec(body)?.[1]?.trim() ?? '';
    const notes = /## Notes\n([\s\S]*)$/.exec(body)?.[1]?.trim() ?? '';
    return {
      id: front.id,
      task: front.task ?? '',
      status: front.status ?? 'queued',
      created: front.created ?? '',
      updated: front.updated ?? '',
      cwd: front.cwd ?? '',
      budget: front.budget ?? { max_attempts: 0, max_minutes: 0, max_cost_usd: 0 },
      escalation: front.escalation ?? [],
      allowed_agents: front.allowed_agents ?? [],
      files: front.files ?? [],
      context: front.context,
      attempts: front.attempts ?? [],
      objective,
      notes: notes.startsWith('_Your notes.') ? '' : notes,
    };
  } catch {
    return null;
  }
}

export function loadManifest(p: Pick<MemoryPaths, 'tasksDir'>, id: string): TaskManifest | null {
  const path = manifestPath(p, id);
  return existsSync(path) ? parseManifest(readFileSync(path, 'utf8')) : null;
}

export function saveManifest(p: Pick<MemoryPaths, 'tasksDir'>, m: TaskManifest): void {
  // les notes écrites à la main sont conservées même si le manifeste en mémoire est plus ancien
  const existing = loadManifest(p, m.id);
  const next = { ...m, notes: existing?.notes || m.notes };
  writeFileSync(manifestPath(p, m.id), serializeManifest(next), 'utf8');
}

/** Manifestes du plus récent au plus ancien. */
export function listManifests(p: Pick<MemoryPaths, 'tasksDir'>, limit = 50): TaskManifest[] {
  if (!existsSync(p.tasksDir)) return [];
  return readdirSync(p.tasksDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseManifest(readFileSync(join(p.tasksDir, f), 'utf8')))
    .filter((m): m is TaskManifest => m !== null)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, limit);
}

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { redact } from '../util/redact.js';
import { ensureMemory, type MemoryPaths } from './layout.js';
import { clip, renderEntry } from './md.js';
import {
  listManifests,
  saveManifest,
  titleOf,
  type AttemptRecord,
  type FailureRecord,
  type TaskManifest,
  type TaskStatus,
} from './manifest.js';

export interface TimelineEvent {
  ts: number;
  kind:
    | 'task_started'
    | 'context_built'
    | 'attempt_started'
    | 'attempt_finished'
    | 'snapshot'
    | 'verify'
    | 'diagnosis'
    | 'decision'
    | 'rollback'
    | 'usage'
    | 'task_finished'
    | 'note';
  message: string;
  data?: Record<string, unknown>;
}

export interface RecorderInit {
  cwd: string;
  cfg: Pick<Config, 'memory' | 'escalation'>;
  id: string;
  prompt: string;
  /** cibles prévues, dans l'ordre d'escalade */
  escalation: string[];
  now?: () => number;
}

const two = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const hhmmss = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/**
 * Écrit la mémoire Markdown d'une tâche : manifeste (`tasks/<id>.md`), chronologie (`sessions/` + `runs/`),
 * échecs (`failures.md`), état (`state.md`) et index (`tasks.md`). Toute écriture est protégée : un problème de
 * fichier ne doit jamais interrompre une exécution. Tout texte écrit passe par `redact`.
 */
export class TaskRecorder {
  readonly paths: MemoryPaths;
  manifest: TaskManifest;
  private readonly now: () => number;
  private readonly day: string;
  private warnings: string[] = [];

  private constructor(paths: MemoryPaths, init: RecorderInit) {
    this.paths = paths;
    this.now = init.now ?? Date.now;
    const at = new Date(this.now());
    this.day = isoDay(at);
    this.manifest = {
      id: init.id,
      task: redact(titleOf(init.prompt)),
      status: 'implementing',
      created: at.toISOString(),
      updated: at.toISOString(),
      cwd: init.cwd,
      budget: {
        max_attempts: init.cfg.escalation.max_attempts,
        max_minutes: init.cfg.escalation.max_minutes,
        max_cost_usd: init.cfg.escalation.max_cost_usd,
      },
      escalation: init.escalation,
      allowed_agents: [...new Set(init.escalation.map((t) => t.split(':')[0]!))],
      files: [],
      attempts: [],
      objective: init.prompt,
      notes: '',
    };
  }

  /** `null` quand la mémoire est désactivée ou que le dossier n'est pas utilisable. */
  static create(init: RecorderInit): TaskRecorder | null {
    const paths = ensureMemory(init.cwd, init.cfg);
    if (!paths) return null;
    const r = new TaskRecorder(paths, init);
    r.safe(() => saveManifest(paths, r.manifest));
    r.event('task_started', `Task started: ${r.manifest.task}`, { escalation: init.escalation });
    r.safe(() => r.writeIndex());
    return r;
  }

  get id() {
    return this.manifest.id;
  }

  /** erreurs d'écriture rencontrées (jamais levées) */
  get problems(): readonly string[] {
    return this.warnings;
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.warnings.push((e as Error).message);
    }
  }

  private timelinePaths() {
    return {
      md: join(this.paths.sessionsDir, `${this.day}-${this.manifest.id}.md`),
      jsonl: join(this.paths.runsDir, `${this.manifest.id}.jsonl`),
    };
  }

  event(kind: TimelineEvent['kind'], message: string, data?: Record<string, unknown>) {
    const ev: TimelineEvent = { ts: this.now(), kind, message: redact(message), data };
    const { md, jsonl } = this.timelinePaths();
    this.safe(() => {
      if (!existsSync(md)) writeFileSync(md, `# ${this.manifest.task}\n\n<!-- Session ${this.manifest.id}, ${this.day} -->\n\n`, 'utf8');
      appendFileSync(md, `- ${hhmmss(new Date(ev.ts))} ${ev.message}\n`, 'utf8');
      appendFileSync(jsonl, JSON.stringify({ ...ev, data: ev.data ? JSON.parse(redact(JSON.stringify(ev.data))) : undefined }) + '\n', 'utf8');
    });
  }

  private flush(status?: TaskStatus) {
    if (status) this.manifest.status = status;
    this.manifest.updated = new Date(this.now()).toISOString();
    this.safe(() => saveManifest(this.paths, this.manifest));
  }

  contextUsed(summary: TaskManifest['context']) {
    this.manifest.context = summary;
    this.event('context_built', `Context: ${summary?.files ?? 0} files, ${summary?.decisions ?? 0} decisions, ${summary?.failures ?? 0} previous failures (${summary?.chars ?? 0} chars)`, { ...summary });
    this.flush();
  }

  attemptStarted(n: number, target: { id: string; label: string }, snapshotBefore?: string) {
    const a: AttemptRecord = { n, target: target.id, label: target.label, startedAt: new Date(this.now()).toISOString(), filesChanged: [], snapshotBefore };
    this.manifest.attempts.push(a);
    this.event('attempt_started', `${target.label} started (attempt ${n})`, { n, target: target.id });
    this.flush('implementing');
  }

  attempt(n: number): AttemptRecord | undefined {
    return this.manifest.attempts.find((a) => a.n === n);
  }

  attemptFinished(n: number, patch: Partial<AttemptRecord>) {
    const a = this.attempt(n);
    if (!a) return;
    Object.assign(a, patch, { endedAt: new Date(this.now()).toISOString() });
    if (patch.filesChanged) this.manifest.files = [...new Set([...this.manifest.files, ...patch.filesChanged])].slice(0, 200);
    this.event('attempt_finished', `${a.label} ${a.ok ? 'finished' : 'failed'}: ${a.filesChanged.length} file(s) modified`, {
      n,
      ok: a.ok,
      files: a.filesChanged.length,
      durationMs: a.durationMs,
    });
    this.flush();
  }

  verifying() {
    this.flush('verifying');
  }

  verify(n: number, steps: NonNullable<AttemptRecord['verify']>) {
    const a = this.attempt(n);
    if (a) a.verify = steps;
    for (const s of steps) this.event('verify', `${s.command.replace(/^(npm|pnpm|yarn|bun) (run )?-?s? ?/, '')} ${s.ok ? 'PASS' : 'FAIL'}`, { command: s.command, ok: s.ok, ms: s.ms, exitCode: s.exitCode });
    this.flush();
  }

  /** enregistre l'échec d'une tentative dans le manifeste et dans `failures.md` */
  failure(n: number, failure: FailureRecord, extra: { files: string[]; output?: string }) {
    const a = this.attempt(n);
    if (a) a.failure = failure;
    this.event('diagnosis', `Failure diagnosed: ${failure.kind} — ${failure.summary}`, { n, kind: failure.kind, fingerprint: failure.fingerprint });
    this.safe(() => {
      const at = new Date(this.now());
      const entry = renderEntry(
        `${isoDay(at)} ${hhmmss(at).slice(0, 5)} · ${this.manifest.id} · attempt ${n} · ${a?.target ?? '?'}`,
        [
          `kind: ${failure.kind}`,
          `task: ${this.manifest.task}`,
          failure.command ? `command: ${failure.command}` : '',
          extra.files.length ? `files: ${extra.files.slice(0, 12).join(', ')}` : '',
          `summary: ${clip(failure.summary, 200)}`,
        ],
        extra.output ? redact(extra.output).slice(-1500) : undefined,
      );
      appendFileSync(this.paths.failures, redact(entry), 'utf8');
    });
    this.flush();
  }

  decision(n: number, next: NonNullable<AttemptRecord['next']>) {
    const a = this.attempt(n);
    if (a) a.next = next;
    this.event('decision', `Decision after attempt ${n}: ${next.action}${next.to ? ` → ${next.to}` : ''} — ${next.reason}`, { n, ...next });
    this.flush(next.action === 'escalate' ? 'escalating' : undefined);
  }

  finish(status: TaskStatus, message?: string) {
    this.event('task_finished', `Task ${status}${message ? `: ${message}` : ''}`, { status });
    this.flush(status);
    this.safe(() => this.writeState());
    this.safe(() => this.writeIndex());
  }

  /** `state.md` : instantané lisible de la dernière tâche (régénéré, jamais édité à la main) */
  private writeState() {
    const m = this.manifest;
    const last = m.attempts.at(-1);
    const verify = last?.verify?.map((v) => `${v.ok ? '✓' : '✗'} ${v.command}`).join(' · ') || 'not run';
    const lines = [
      '# Current state',
      '',
      `<!-- Regenerated by CodeBreak at the end of each task. -->`,
      '',
      `- **Last task:** ${m.task} (\`${m.id}\`) — ${m.status}`,
      `- **Updated:** ${m.updated}`,
      `- **Agent:** ${last ? last.label : 'n/a'} (${m.attempts.length} attempt${m.attempts.length === 1 ? '' : 's'})`,
      `- **Files modified:** ${m.files.length ? m.files.slice(0, 20).join(', ') : 'none'}`,
      `- **Verification:** ${verify}`,
      last?.failure ? `- **Last failure:** ${last.failure.kind} — ${clip(last.failure.summary, 160)}` : '',
      m.status === 'failed' || m.status === 'aborted' ? '- **Next:** review `failures.md`, then retry or continue by hand.' : '',
    ].filter((l) => l !== '');
    writeFileSync(this.paths.state, redact(lines.join('\n')) + '\n', 'utf8');
  }

  private writeIndex() {
    const rows = listManifests(this.paths, 50).map((t) => `| \`${t.id}\` | ${t.status} | ${t.updated.slice(0, 16).replace('T', ' ')} | ${t.attempts.length} | ${clip(t.task, 70).replace(/\|/g, '\\|')} |`);
    const table = ['| id | status | updated | attempts | task |', '|---|---|---|---|---|', ...rows].join('\n');
    writeFileSync(this.paths.tasks, `# Tasks\n\n<!-- Index regenerated by CodeBreak; the manifests live in tasks/. -->\n\n${table}\n`, 'utf8');
  }

  /** chronologie complète, lue depuis le fichier (survit au redémarrage) */
  static readTimeline(paths: Pick<MemoryPaths, 'runsDir'>, id: string): TimelineEvent[] {
    const file = join(paths.runsDir, `${id}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TimelineEvent];
        } catch {
          return [];
        }
      });
  }
}

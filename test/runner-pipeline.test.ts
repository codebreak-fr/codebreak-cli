import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunRequest } from '../src/backends/index.js';
import { runTask, type TaskEvent } from '../src/exec/runner.js';
import { memoryPaths } from '../src/memory/layout.js';
import { listManifests } from '../src/memory/manifest.js';
import { TaskRecorder } from '../src/memory/recorder.js';
import type { RunEvent } from '../src/types.js';
import { decisionOf, defaultCfg, detection, tempHome, targetsOf } from './helpers.js';

beforeAll(() => {
  process.env.CODEBREAK_HOME = tempHome();
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

/**
 * Projet dont le `typecheck` échoue avec une erreur TypeScript tant que `ok.txt` n'existe pas ;
 * `wrong.txt` provoque une AUTRE erreur (autre empreinte).
 */
function tsProject(script = 'node tc.js') {
  const dir = mkdtempSync(join(tmpdir(), 'cb-pipe-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', scripts: { typecheck: script } }));
  writeFileSync(
    join(dir, 'tc.js'),
    `const fs=require('fs');
if(fs.existsSync('ok.txt'))process.exit(0);
if(fs.existsSync('env.txt')){console.error('Error: listen EADDRINUSE: address already in use :::3000');process.exit(1)}
const code=fs.existsSync('other.txt')?'TS2345':'TS2322';
console.log('src/a.ts(3,5): error '+code+': Type error');process.exit(1)`,
  );
  writeFileSync(join(dir, 'user.txt'), 'original\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

type Script = (req: RunRequest) => RunEvent[];
const scripted = (scripts: Record<string, Script>, calls: string[] = []) =>
  async function* (req: RunRequest) {
    calls.push(req.target.id);
    for (const e of (scripts[req.target.id] ?? (() => []))(req)) yield e;
  };

async function collect(gen: AsyncGenerator<TaskEvent>) {
  const out: TaskEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const done = (evs: TaskEvent[]) => evs.find((e) => e.type === 'done') as Extract<TaskEvent, { type: 'done' }>;
const of = <K extends TaskEvent['type']>(evs: TaskEvent[], type: K) => evs.filter((e) => e.type === type) as Extract<TaskEvent, { type: K }>[];

const T = targetsOf();
const local = T['ollama:ministral-3:8b']!;
const free = T['opencode:opencode/big-pickle']!;
const sonnet = T['claude:sonnet']!;

const base = (cwd: string, chain = [local, free, sonnet], cfg = defaultCfg()) => ({
  prompt: 'fix the type error in src/a.ts',
  decision: decisionOf(chain),
  cwd,
  cfg,
  det: detection,
  signal: new AbortController().signal,
});
const put = (cwd: string, f: string, c = 'x') => writeFileSync(join(cwd, f), c);

describe('pipeline agent → vérification → diagnostic → retry / escalade', () => {
  it('erreur de typage simple : le MÊME agent réessaie avec le diagnostic, sans escalade', async () => {
    const cwd = tsProject();
    const calls: string[] = [];
    const prompts: string[] = [];
    const evs = await collect(
      runTask({
        ...base(cwd),
        runner: scripted(
          {
            [local.id]: (req) => {
              prompts.push(req.prompt);
              put(cwd, prompts.length === 1 ? 'wrong.txt' : 'ok.txt');
              return [{ type: 'text', text: 'done' }];
            },
          },
          calls,
        ),
      }),
    );
    expect(calls).toEqual([local.id, local.id]);
    expect(of(evs, 'diagnosis')[0]!.diagnosis).toMatchObject({ kind: 'typecheck', errorCount: 1 });
    expect(of(evs, 'retry')).toHaveLength(1);
    expect(of(evs, 'escalate')).toHaveLength(0);
    expect(prompts[1]).toMatch(/Nouvelle tentative/);
    expect(prompts[1]).toMatch(/1 type error \(TS2322\)/);
    expect(done(evs)).toMatchObject({ ok: true, verified: true, target: { id: local.id } });
  });

  it('même erreur après la reprise → escalade vers un agent plus fort (pas de boucle identique)', async () => {
    const cwd = tsProject();
    const calls: string[] = [];
    const evs = await collect(
      runTask({
        ...base(cwd),
        runner: scripted(
          {
            [local.id]: () => {
              put(cwd, 'wrong.txt', `${Date.now()}${Math.random()}`);
              return [{ type: 'text', text: 'again' }];
            },
            [free.id]: () => {
              put(cwd, 'ok.txt');
              return [{ type: 'text', text: 'ok' }];
            },
          },
          calls,
        ),
      }),
    );
    expect(calls).toEqual([local.id, local.id, free.id]);
    expect(of(evs, 'retry')).toHaveLength(1);
    expect(of(evs, 'escalate')).toHaveLength(1);
    expect(done(evs)).toMatchObject({ ok: true, target: { id: free.id } });
  });

  it('problème d’environnement : arrêt immédiat, aucun quota gaspillé', async () => {
    const cwd = tsProject();
    const calls: string[] = [];
    const evs = await collect(
      runTask({
        ...base(cwd),
        runner: scripted({ [local.id]: () => (put(cwd, 'env.txt'), [{ type: 'text', text: 'x' }]) }, calls),
      }),
    );
    expect(calls).toEqual([local.id]);
    expect(done(evs)).toMatchObject({ ok: false });
    expect(done(evs).message).toMatch(/environnement/);
    expect(of(evs, 'diagnosis')[0]!.diagnosis.kind).toBe('environment');
  });

  it('n’attribue jamais à l’agent le travail que l’utilisateur avait déjà en cours', async () => {
    const cwd = tsProject();
    put(cwd, 'user.txt', 'USER work in progress\n');
    put(cwd, 'notes.md', 'USER untracked notes\n');
    const evs = await collect(runTask({ ...base(cwd), runner: scripted({ [local.id]: () => (put(cwd, 'ok.txt'), [{ type: 'text', text: 'ok' }]) }) }));
    expect(done(evs)).toMatchObject({ ok: true, filesChanged: ['ok.txt'] });
    expect(readFileSync(join(cwd, 'user.txt'), 'utf8')).toBe('USER work in progress\n');
  });

  it('agent qui ne fait rien alors que des fichiers utilisateur sont modifiés → « aucune modification »', async () => {
    const cwd = tsProject();
    put(cwd, 'user.txt', 'USER work in progress\n');
    const evs = await collect(
      runTask({ ...base(cwd), runner: scripted({ [local.id]: () => [{ type: 'text', text: "j'ai tout fait" }], [free.id]: () => (put(cwd, 'ok.txt'), [{ type: 'text', text: 'ok' }]) }) }),
    );
    expect(of(evs, 'diagnosis')[0]!.diagnosis.kind).toBe('no_change');
    expect(done(evs)).toMatchObject({ ok: true, target: { id: free.id } });
  });

  it('rollback « always » : la tentative ratée est annulée, le travail utilisateur est conservé', async () => {
    const cwd = tsProject();
    put(cwd, 'user.txt', 'USER work in progress\n');
    const cfg = { ...defaultCfg(), escalation: { ...defaultCfg().escalation, same_agent_retries: 0, rollback: 'always' as const } };
    let seenByNext: { wrong: boolean; user: string } | undefined;
    const evs = await collect(
      runTask({
        ...base(cwd, [local, free], cfg),
        runner: scripted({
          [local.id]: () => (put(cwd, 'wrong.txt'), [{ type: 'text', text: 'x' }]),
          [free.id]: () => {
            seenByNext = { wrong: existsSync(join(cwd, 'wrong.txt')), user: readFileSync(join(cwd, 'user.txt'), 'utf8') };
            put(cwd, 'ok.txt');
            return [{ type: 'text', text: 'ok' }];
          },
        }),
      }),
    );
    expect(of(evs, 'rollback')[0]).toMatchObject({ removed: ['wrong.txt'], skipped: 0 });
    expect(seenByNext).toEqual({ wrong: false, user: 'USER work in progress\n' });
    expect(done(evs).ok).toBe(true);
  });

  it('budget de coût : arrêt explicite au lieu d’escalader', async () => {
    const cwd = tsProject();
    const cfg = { ...defaultCfg(), escalation: { ...defaultCfg().escalation, same_agent_retries: 0, max_cost_usd: 1 } };
    const evs = await collect(
      runTask({
        ...base(cwd, [local, sonnet], cfg),
        runner: scripted({ [local.id]: () => (put(cwd, 'wrong.txt'), [{ type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 2 }, { type: 'text', text: 'x' }]) }),
      }),
    );
    expect(done(evs)).toMatchObject({ ok: false });
    expect(done(evs).message).toMatch(/coût/);
    expect(of(evs, 'attempt')).toHaveLength(1);
  });

  it('délai maximal par tentative : un agent bloqué est interrompu puis remplacé', async () => {
    const cwd = tsProject();
    const cfg = { ...defaultCfg(), escalation: { ...defaultCfg().escalation, attempt_timeout_minutes: 0.002 } };
    const evs = await collect(
      runTask({
        ...base(cwd, [local, free], cfg),
        runner: async function* (req) {
          if (req.target.id === local.id) {
            await new Promise((_r, rej) => req.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
          }
          put(cwd, 'ok.txt');
          yield { type: 'text', text: 'ok' } as RunEvent;
        },
      }),
    );
    expect(of(evs, 'escalate')[0]!.reason).toMatch(/délai maximal/);
    expect(done(evs)).toMatchObject({ ok: true, target: { id: free.id } });
  });

  it('agent indisponible (quota) : ce backend n’est plus réessayé, on passe à un autre', async () => {
    const cwd = tsProject();
    const calls: string[] = [];
    const evs = await collect(
      runTask({
        ...base(cwd, [sonnet, T['claude:opus']!, free]),
        runner: scripted(
          {
            [sonnet.id]: () => [{ type: 'error', kind: 'quota', message: 'limit reached' }],
            [free.id]: () => (put(cwd, 'ok.txt'), [{ type: 'text', text: 'ok' }]),
          },
          calls,
        ),
      }),
    );
    expect(calls).toEqual([sonnet.id, free.id]);
    expect(done(evs)).toMatchObject({ ok: true, target: { id: free.id } });
  });

  it('un agent qui plante ne fait pas planter CodeBreak', async () => {
    const cwd = tsProject();
    const evs = await collect(
      runTask({
        ...base(cwd),
        runner: async function* (req) {
          if (req.target.id === local.id) throw new Error('segfault');
          put(cwd, 'ok.txt');
          yield { type: 'text', text: 'ok' } as RunEvent;
        },
      }),
    );
    expect(done(evs).ok).toBe(true);
  });
});

describe('mémoire Markdown pendant l’exécution', () => {
  it('écrit manifeste, échecs, état et chronologie ; les fichiers de mémoire ne comptent pas comme travail de l’agent', async () => {
    const cwd = tsProject();
    const cfg = defaultCfg();
    const rec = TaskRecorder.create({ cwd, cfg, id: 'run00001', prompt: 'fix the type error in src/a.ts', escalation: [local.id, free.id] })!;
    let n = 0;
    const evs = await collect(
      runTask({
        ...base(cwd, [local, free]),
        taskId: 'run00001',
        recorder: rec,
        runner: scripted({
          [local.id]: () => (put(cwd, 'wrong.txt', String(++n)), [{ type: 'text', text: 'x' }]),
          [free.id]: () => (put(cwd, 'ok.txt'), [{ type: 'text', text: 'ok' }]),
        }),
      }),
    );
    expect(done(evs)).toMatchObject({ ok: true, taskId: 'run00001', filesChanged: ['ok.txt'] });
    const p = memoryPaths(cwd, cfg);
    const m = listManifests(p)[0]!;
    expect(m.status).toBe('done');
    expect(m.attempts.map((a) => [a.n, a.target, a.ok])).toEqual([[1, local.id, false], [2, local.id, false], [3, free.id, true]]);
    expect(m.attempts[0]!.failure).toMatchObject({ kind: 'typecheck' });
    expect(m.attempts[1]!.next).toMatchObject({ action: 'escalate', to: free.id });
    expect(readFileSync(p.failures, 'utf8')).toMatch(/kind: typecheck/);
    expect(readFileSync(p.state, 'utf8')).toMatch(/done/);
    const kinds = TaskRecorder.readTimeline(p, 'run00001').map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['task_started', 'attempt_started', 'verify', 'diagnosis', 'decision', 'attempt_finished', 'task_finished']));
  });

  it('un dossier de mémoire créé avant la tentative ne fait pas croire à une modification', async () => {
    const cwd = tsProject();
    const cfg = defaultCfg();
    const rec = TaskRecorder.create({ cwd, cfg, id: 'run00002', prompt: 'x', escalation: [local.id, free.id] })!;
    const evs = await collect(
      runTask({ ...base(cwd, [local, free]), taskId: 'run00002', recorder: rec, runner: scripted({ [local.id]: () => [{ type: 'text', text: 'claims' }], [free.id]: () => (put(cwd, 'ok.txt'), [{ type: 'text', text: 'ok' }]) }) }),
    );
    expect(of(evs, 'diagnosis')[0]!.diagnosis.kind).toBe('no_change');
    expect(mkdirSyncSafe(join(cwd, '.codebreak'))).toBe(true);
  });
});

function mkdirSyncSafe(dir: string) {
  mkdirSync(dir, { recursive: true });
  return existsSync(dir);
}

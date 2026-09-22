import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunRequest } from '../src/backends/index.js';
import { runTask, type TaskEvent } from '../src/exec/runner.js';
import type { RunEvent } from '../src/types.js';
import { decisionOf, defaultCfg, detection, tempHome, tempRepo, targetsOf } from './helpers.js';

beforeAll(() => {
  process.env.CODEBREAK_HOME = tempHome();
});

type Script = (req: RunRequest) => RunEvent[];
const scripted = (scripts: Record<string, Script>) =>
  async function* (req: RunRequest) {
    for (const e of (scripts[req.target.id] ?? (() => []))(req)) yield e;
  };

async function collect(gen: AsyncGenerator<TaskEvent>) {
  const out: TaskEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const done = (evs: TaskEvent[]) => evs.find((e) => e.type === 'done') as Extract<TaskEvent, { type: 'done' }>;
const t = targetsOf();

const base = (repo: string, chain = [t['ollama:ministral-3:8b']!, t['opencode:opencode/big-pickle']!, t['claude:sonnet']!]) => ({
  prompt: 'crée ok.txt',
  decision: decisionOf(chain),
  cwd: repo,
  cfg: defaultCfg(),
  det: detection,
  signal: new AbortController().signal,
});

describe('exécution avec escalade', () => {
  it('réussit du premier coup : tests OK → fin', async () => {
    const repo = tempRepo();
    const evs = await collect(
      runTask({
        ...base(repo),
        runner: scripted({
          'ollama:ministral-3:8b': () => {
            writeFileSync(join(repo, 'ok.txt'), 'x');
            return [{ type: 'text', text: 'fait' }];
          },
        }),
      }),
    );
    expect(done(evs)).toMatchObject({ ok: true, verified: true });
    expect(evs.filter((e) => e.type === 'attempt')).toHaveLength(1);
  });

  it('erreur du backend → escalade vers le niveau suivant', async () => {
    const repo = tempRepo();
    const evs = await collect(
      runTask({
        ...base(repo),
        runner: scripted({
          'ollama:ministral-3:8b': () => [{ type: 'error', kind: 'crash', message: 'boom' }],
          'opencode:opencode/big-pickle': () => {
            writeFileSync(join(repo, 'ok.txt'), 'x');
            return [{ type: 'text', text: 'ok' }];
          },
        }),
      }),
    );
    expect(evs.some((e) => e.type === 'escalate')).toBe(true);
    expect(done(evs)).toMatchObject({ ok: true, target: expect.objectContaining({ id: 'opencode:opencode/big-pickle' }) });
  });

  it('modèle gratuit qui affirme sans modifier de fichier → escalade (pas cru sur parole)', async () => {
    const repo = tempRepo();
    const evs = await collect(
      runTask({
        ...base(repo),
        runner: scripted({
          'ollama:ministral-3:8b': () => [{ type: 'text', text: "J'ai créé le fichier !" }],
          'opencode:opencode/big-pickle': () => {
            writeFileSync(join(repo, 'ok.txt'), 'x');
            return [{ type: 'text', text: 'ok' }];
          },
        }),
      }),
    );
    const esc = evs.find((e) => e.type === 'escalate') as Extract<TaskEvent, { type: 'escalate' }>;
    expect(esc.reason).toMatch(/aucune modification/);
    expect(done(evs).ok).toBe(true);
  });

  it('les tests échouent → escalade avec la sortie de l’échec dans le prompt suivant', async () => {
    const repo = tempRepo();
    const prompts: string[] = [];
    const evs = await collect(
      runTask({
        ...base(repo),
        runner: scripted({
          'ollama:ministral-3:8b': () => {
            writeFileSync(join(repo, 'wrong.txt'), 'x'); // modifie mais ne satisfait pas le test
            return [{ type: 'text', text: 'fait' }];
          },
          'opencode:opencode/big-pickle': (req) => {
            prompts.push(req.prompt);
            writeFileSync(join(repo, 'ok.txt'), 'x');
            return [{ type: 'text', text: 'ok' }];
          },
        }),
      }),
    );
    expect(evs.some((e) => e.type === 'verify_result' && !e.result.ok)).toBe(true);
    expect(prompts[0]).toMatch(/Contexte d’escalade/);
    expect(prompts[0]).toMatch(/npm run -s test/);
    expect(done(evs)).toMatchObject({ ok: true, verified: true });
  });

  it('toutes les tentatives échouent → ok=false, sans boucler', async () => {
    const repo = tempRepo();
    const evs = await collect(
      runTask({
        ...base(repo),
        runner: scripted({
          'ollama:ministral-3:8b': () => [{ type: 'error', kind: 'crash', message: 'a' }],
          'opencode:opencode/big-pickle': () => [{ type: 'error', kind: 'crash', message: 'b' }],
          'claude:sonnet': () => [{ type: 'error', kind: 'quota', message: 'limite' }],
        }),
      }),
    );
    expect(done(evs)).toMatchObject({ ok: false, message: 'limite' });
    expect(evs.filter((e) => e.type === 'attempt')).toHaveLength(3);
  });

  it('vérification désactivée : pas de commande lancée', async () => {
    const repo = tempRepo();
    const cfg = { ...defaultCfg(), verify: { ...defaultCfg().verify, mode: 'off' as const } };
    const evs = await collect(
      runTask({
        ...base(repo),
        cfg,
        runner: scripted({
          'ollama:ministral-3:8b': () => {
            writeFileSync(join(repo, 'wrong.txt'), 'x');
            return [{ type: 'text', text: 'fait' }];
          },
        }),
      }),
    );
    expect(evs.some((e) => e.type === 'verify_start')).toBe(false);
    expect(done(evs).ok).toBe(true);
  });

  it('cible terminale (Copilot) : passation, ni vérification ni escalade', async () => {
    const repo = tempRepo();
    const evs = await collect(
      runTask({
        ...base(repo, [t['copilot:agent']!]),
        runner: scripted({ 'copilot:agent': () => [{ type: 'handoff', message: 'envoyé' }] }),
      }),
    );
    expect(done(evs)).toMatchObject({ ok: true, handoff: true });
  });

  it('question (aucune modification attendue) sur cible gratuite → pas d’escalade', async () => {
    const repo = tempRepo();
    const chain = [t['opencode:opencode/big-pickle']!, t['claude:sonnet']!];
    const evs = await collect(
      runTask({
        ...base(repo, chain),
        decision: decisionOf(chain, { needsEdit: false, needsRepo: true, category: 'question' }),
        runner: scripted({ 'opencode:opencode/big-pickle': () => [{ type: 'text', text: 'explication' }] }),
      }),
    );
    expect(evs.some((e) => e.type === 'escalate')).toBe(false);
    expect(done(evs).ok).toBe(true);
  });

  it('interruption : arrêt immédiat', async () => {
    const repo = tempRepo();
    const ac = new AbortController();
    const evs = await collect(
      runTask({
        ...base(repo),
        signal: ac.signal,
        runner: scripted({
          'ollama:ministral-3:8b': () => {
            ac.abort();
            return [{ type: 'text', text: 'x' }];
          },
        }),
      }),
    );
    expect(done(evs)).toMatchObject({ ok: false, message: 'Interrompu.' });
    expect(evs.filter((e) => e.type === 'attempt')).toHaveLength(1);
  });
});

describe('robustesse du runner', () => {
  it('une exception d’adaptateur devient une erreur et déclenche l’escalade', async () => {
    const repo = tempRepo();
    const evs = await collect(
      runTask({
        ...base(repo),
        runner: async function* (req) {
          if (req.target.id === 'ollama:ministral-3:8b') throw new Error('spawn ENOENT');
          writeFileSync(join(repo, 'ok.txt'), 'x');
          yield { type: 'text', text: 'ok' } as RunEvent;
        },
      }),
    );
    const esc = evs.find((e) => e.type === 'escalate') as Extract<TaskEvent, { type: 'escalate' }>;
    expect(esc.reason).toMatch(/ENOENT/);
    expect(done(evs).ok).toBe(true);
  });

  it('une interruption pendant le flux (exception d’abandon) est signalée proprement', async () => {
    const repo = tempRepo();
    const ac = new AbortController();
    const evs = await collect(
      runTask({
        ...base(repo),
        signal: ac.signal,
        runner: async function* () {
          yield { type: 'text', text: 'début', delta: true } as RunEvent;
          ac.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        },
      }),
    );
    expect(done(evs)).toMatchObject({ ok: false, message: 'Interrompu.', text: 'début' });
  });
});

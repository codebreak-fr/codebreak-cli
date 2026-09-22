import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCopilot } from '../src/backends/copilot.js';
import type { RunEvent } from '../src/types.js';
import { defaultCfg, detection, targetsOf, tempHome } from './helpers.js';

describe('Copilot (VS Code)', () => {
  it('ouvre le dossier puis envoie le prompt à `code chat` en mode agent', async () => {
    const dir = tempHome();
    const log = join(dir, 'calls.log');
    const stub = join(dir, 'code');
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(stub, 0o755);
    const events: RunEvent[] = [];
    for await (const e of runCopilot({
      prompt: 'ajoute un bouton',
      cwd: dir,
      target: targetsOf()['copilot:agent']!,
      signal: new AbortController().signal,
      cfg: defaultCfg(),
      det: { ...detection, copilot: { ...detection.copilot, path: stub } },
    })) events.push(e);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe(dir);
    expect(calls[1]).toBe('chat -m agent -r ajoute un bouton');
    expect(events[0]?.type).toBe('handoff');
  });

  it('échec de `code chat` → erreur explicite', async () => {
    const dir = tempHome();
    const stub = join(dir, 'code');
    writeFileSync(stub, '#!/bin/sh\necho boom >&2\nexit 3\n');
    chmodSync(stub, 0o755);
    const cfg = { ...defaultCfg(), copilot: { ...defaultCfg().copilot, open_folder: false } };
    const events: RunEvent[] = [];
    for await (const e of runCopilot({
      prompt: 'x', cwd: dir, target: targetsOf()['copilot:agent']!, signal: new AbortController().signal, cfg,
      det: { ...detection, copilot: { ...detection.copilot, path: stub } },
    })) events.push(e);
    expect(events[0]).toMatchObject({ type: 'error', kind: 'unavailable' });
  });

  it('quota épuisé → erreur de type quota', async () => {
    const dir = tempHome();
    const stub = join(dir, 'code');
    writeFileSync(stub, '#!/bin/sh\necho "You have exhausted your premium model quota" >&2\nexit 1\n');
    chmodSync(stub, 0o755);
    const cfg = { ...defaultCfg(), copilot: { ...defaultCfg().copilot, open_folder: false } };
    const events: RunEvent[] = [];
    for await (const e of runCopilot({
      prompt: 'x', cwd: dir, target: targetsOf()['copilot:agent']!, signal: new AbortController().signal, cfg,
      det: { ...detection, copilot: { ...detection.copilot, path: stub } },
    })) events.push(e);
    expect(events[0]).toMatchObject({ type: 'error', kind: 'quota' });
  });
});

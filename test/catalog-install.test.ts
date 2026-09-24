import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterRemoveWrites, useModelWrites } from '../src/catalog/actions.js';
import { hfRepoDir, isInstalled } from '../src/catalog/installed.js';
import { listInstalled, parsePercent, planInstall, planRemove, runRemove } from '../src/catalog/installer.js';
import { detWith, hw, apple16, mk } from './catalog-helpers.js';
import { defaultCfg } from './helpers.js';

const det = detWith(apple16, { huggingface: { installed: true, ready: true, path: '/bin/hf', detail: '' } });

describe('installateur : résolution par runtime', () => {
  it('Ollama → ollama pull', () => {
    const p = planInstall({ runtime: 'ollama', name: 'qwen3:8b', sizeGB: 5 }, det);
    expect(p).toMatchObject({ ok: true, display: 'ollama pull qwen3:8b', argv: ['/bin/ollama', 'pull', 'qwen3:8b'] });
  });
  it('MLX → hf download (Apple Silicon seulement)', () => {
    expect(planInstall({ runtime: 'mlx', name: 'mlx-community/X-4bit' }, det)).toMatchObject({ ok: true, argv: ['/bin/hf', 'download', 'mlx-community/X-4bit'] });
    const intel = detWith(hw({ appleSilicon: false }), { huggingface: det.huggingface });
    expect(planInstall({ runtime: 'mlx', name: 'mlx-community/X' }, intel)).toMatchObject({ ok: false });
  });
  it('Hugging Face → hf download', () => {
    expect(planInstall({ runtime: 'huggingface', name: 'org/model' }, det)).toMatchObject({ ok: true, display: 'hf download org/model' });
  });
  it('runtime absent → erreur explicite, jamais de commande', () => {
    const none = detWith(apple16, { ollama: { ...det.ollama, installed: false, path: undefined }, huggingface: { installed: false, ready: false, detail: '' } });
    expect(planInstall({ runtime: 'ollama', name: 'x' }, none)).toMatchObject({ ok: false });
    expect(planInstall({ runtime: 'huggingface', name: 'x' }, none)).toMatchObject({ ok: false });
  });
  it('progression : dernier pourcentage du flux', () => {
    expect(parsePercent('pulling abc: 12% ▕██')).toBe(12);
    expect(parsePercent('Fetching 3 files:  33%|█\rFetching 3 files:  67%|█')).toBe(67);
    expect(parsePercent('pulling manifest')).toBeUndefined();
  });
});

describe('suppression des modèles installés', () => {
  const cache = () => mkdtempSync(join(tmpdir(), 'cb-hf-'));
  const seed = (root: string, repo: string) => {
    const dir = hfRepoDir(repo, root);
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'blobs', 'w'), 'x'.repeat(2048));
    return dir;
  };

  it('Ollama → ollama rm, espace libéré connu', () => {
    const d = detWith(apple16, { ollama: { ...det.ollama, models: [{ name: 'qwen3:8b', sizeGB: 5.2, capabilities: [], fits: true, loaded: false }] } });
    expect(planRemove({ runtime: 'ollama', name: 'qwen3:8b' }, d)).toMatchObject({ ok: true, argv: ['/bin/ollama', 'rm', 'qwen3:8b'], freedGB: 5.2 });
  });
  it('Hugging Face → purge du dépôt dans le cache, et rien d’autre', async () => {
    const root = cache();
    const dir = seed(root, 'org/model');
    const plan = planRemove({ runtime: 'huggingface', name: 'org/model' }, det, root);
    expect(plan).toMatchObject({ ok: true, dir });
    expect(isInstalled(mk({ runtime: 'huggingface', name: 'org/model' }), det, root)).toBe(true);
    expect((await runRemove(plan as never, root)).ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(isInstalled(mk({ runtime: 'huggingface', name: 'org/model' }), det, root)).toBe(false);
  });
  it('refuse de supprimer hors du cache HF', async () => {
    const root = cache();
    const outside = mkdtempSync(join(tmpdir(), 'cb-outside-'));
    writeFileSync(join(outside, 'keep'), '1');
    const res = await runRemove({ ok: true, runtime: 'huggingface', name: 'x', display: '', dir: outside }, root);
    expect(res.ok).toBe(false);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
  });
  it('modèle absent du cache → plan en erreur', () => {
    expect(planRemove({ runtime: 'huggingface', name: 'nope/nope' }, det, cache())).toMatchObject({ ok: false });
  });
  it('liste des modèles installés : Ollama + cache HF (mlx-community → MLX)', () => {
    const root = cache();
    seed(root, 'mlx-community/Foo-4bit');
    seed(root, 'org/bar');
    const d = detWith(apple16, { ollama: { ...det.ollama, models: [{ name: 'a:1b', sizeGB: 1, capabilities: [], fits: true, loaded: false }] } });
    const list = listInstalled(d, root);
    expect(list.map((m) => `${m.runtime}:${m.name}`).sort()).toEqual(['huggingface:org/bar', 'mlx:mlx-community/Foo-4bit', 'ollama:a:1b']);
  });
  it('supprimer le modèle par défaut le remet à auto', () => {
    const cfg = { ...defaultCfg(), ollama: { ...defaultCfg().ollama, preferred_model: 'qwen3:8b' } };
    expect(afterRemoveWrites({ runtime: 'ollama', name: 'qwen3:8b' }, cfg)).toEqual([['ollama.preferred_model', '']]);
    expect(afterRemoveWrites({ runtime: 'ollama', name: 'autre:1b' }, cfg)).toEqual([]);
    expect(afterRemoveWrites({ runtime: 'mlx', name: 'x' }, cfg)).toEqual([]);
  });
  it('« utiliser ce modèle » : seulement pour un runtime piloté par le routeur', () => {
    const cfg = defaultCfg();
    expect(useModelWrites({ runtime: 'ollama', name: 'qwen3:8b' }, cfg)).toEqual([['ollama.preferred_model', 'qwen3:8b']]);
    expect(useModelWrites({ runtime: 'mlx', name: 'x' }, cfg)).toBeNull();
  });
});

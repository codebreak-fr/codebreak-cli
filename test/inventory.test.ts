import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guessCategory } from '../src/catalog/categories.js';
import { hfRepoDir } from '../src/catalog/installed.js';
import { listInstalled, planRemove, runRemove } from '../src/catalog/installer.js';
import { detectInventory, findModelDirs } from '../src/detect/inventory.js';
import { apple16, detWith } from './catalog-helpers.js';

const put = (path: string, bytes = 1024) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x'.repeat(bytes));
};

/** Reproduit une machine avec MacWhisper (Parakeet + pyannote), Pocket TTS dans le cache HF, oMLX et des scripts Parakeet. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cb-home-'));
  const support = join(home, 'Library', 'Application Support');
  const mw = join(support, 'MacWhisper', 'models');
  put(join(mw, 'whisperkitpro', 'models', 'argmaxinc', 'parakeetkit-pro', 'nvidia_parakeet-v3', 'Encoder.mlmodelc', 'weight.bin'), 4096);
  for (const v of ['W8A16', 'W16A16', 'W32A32']) put(join(mw, 'speakerkit', 'speaker_embedder', 'pyannote-v3', v, 'm.mlmodelc', 'w.bin'));
  put(join(mw, 'whisperkit', 'models', 'openai', 'whisper-large-v3', 'config.json')); // métadonnées seules : pas un modèle
  put(join(support, 'ParakeetCut', 'parakeet_transcribe.py'));
  mkdirSync(join(home, '.omlx', 'models'), { recursive: true });
  const hf = join(home, 'hf');
  put(join(hf, 'models--kyutai--pocket-tts', 'blobs', 'w'), 8192);
  put(join(hf, 'models--mlx-community--S3TokenizerV2', 'blobs', 'w'), 2048);
  put(join(hf, 'CACHEDIR.TAG'));
  return { home, hf, mw };
}

describe('inventaire des IA installées', () => {
  it('trouve MacWhisper/Parakeet, Pocket TTS, oMLX et les scripts Parakeet', async () => {
    const { home, hf } = fakeHome();
    const inv = await detectInventory({ home, hfRoot: hf, skipPython: true });
    const byName = Object.fromEntries(inv.models.map((m) => [m.name, m]));
    expect(byName['parakeetkit-pro/nvidia_parakeet-v3']).toMatchObject({ store: 'MacWhisper', category: 'stt', runtime: 'app' });
    expect(byName['kyutai/pocket-tts']).toMatchObject({ store: 'Hugging Face', category: 'tts' });
    expect(inv.apps.map((a) => a.name)).toEqual(expect.arrayContaining(['oMLX', 'ParakeetCut']));
  });
  it('regroupe les variantes de précision (W8A16…) en un seul modèle et ignore les métadonnées seules', async () => {
    const { home, hf, mw } = fakeHome();
    const dirs = findModelDirs(mw);
    expect(dirs.filter((d) => d.includes('pyannote-v3'))).toHaveLength(1);
    expect(dirs.some((d) => d.includes('whisper-large-v3'))).toBe(false);
    const inv = await detectInventory({ home, hfRoot: hf, skipPython: true });
    expect(inv.models.filter((m) => m.name.includes('pyannote'))).toHaveLength(1);
  });
  it('catégorie d’après le nom : STT, TTS, composants exclus', () => {
    expect(guessCategory('nvidia_parakeet-v3')).toBe('stt');
    expect(guessCategory('openai/whisper-large-v3')).toBe('stt');
    expect(guessCategory('kyutai/pocket-tts')).toBe('tts');
    expect(guessCategory('Qwen/Qwen3-TTS-12Hz-1.7B-Base')).toBe('tts');
    expect(guessCategory('mlx-community/S3TokenizerV2')).toBeUndefined();
    expect(guessCategory('pyannote-v3')).toBeUndefined();
    expect(guessCategory('mlx-community/Qwen3-0.6B-4bit')).toBe('general');
  });
  it('listInstalled réunit Ollama, cache HF et dossiers d’apps ; suppression limitée aux racines connues', async () => {
    const { home, hf, mw } = fakeHome();
    const inv = await detectInventory({ home, hfRoot: hf, skipPython: true });
    const det = detWith(apple16, { inventory: inv, ollama: { ...detWith(apple16).ollama, models: [{ name: 'qwen3:8b', sizeGB: 5, capabilities: ['completion', 'tools'], fits: true, loaded: false }] } });
    const list = listInstalled(det, hf);
    expect(list.map((m) => `${m.store}:${m.name}`)).toEqual(expect.arrayContaining(['Ollama:qwen3:8b', 'Hugging Face:kyutai/pocket-tts', 'MacWhisper:parakeetkit-pro/nvidia_parakeet-v3']));

    const parakeet = list.find((m) => m.name.includes('parakeet'))!;
    const plan = planRemove(parakeet, det, hf);
    expect(plan).toMatchObject({ ok: true, dir: parakeet.path });
    // hors racine autorisée : refusé, fichier conservé
    const refused = await runRemove(plan as never, [join(home, 'ailleurs')]);
    expect(refused.ok).toBe(false);
    expect(existsSync(parakeet.path!)).toBe(true);
    // la racine elle-même n'est jamais supprimable
    expect((await runRemove({ ok: true, runtime: 'app', name: 'x', display: '', dir: mw }, [mw])).ok).toBe(false);
    // racine MacWhisper autorisée : supprimé
    expect((await runRemove(plan as never, [mw])).ok).toBe(true);
    expect(existsSync(parakeet.path!)).toBe(false);
    // Pocket TTS (cache HF) : purge du dépôt
    const pocket = list.find((m) => m.name === 'kyutai/pocket-tts')!;
    expect((await runRemove(planRemove(pocket, det, hf) as never, [hf])).ok).toBe(true);
    expect(existsSync(hfRepoDir('kyutai/pocket-tts', hf))).toBe(false);
  });
});

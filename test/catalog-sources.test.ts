import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog, readRegistry, recordInstalled, forgetInstalled } from '../src/catalog/registry.js';
import { ollamaModelFromTag, parseCount, parseOllamaLibrary, parseOllamaTags } from '../src/catalog/sources/ollama.js';
import { hfQueryUrls, isReferenceModel, parseHfModel } from '../src/catalog/sources/huggingface.js';
import type { CatalogSource } from '../src/catalog/sources/http.js';
import { apple16, mk, NOW } from './catalog-helpers.js';
import { defaultCfg } from './helpers.js';

const LIB_HTML = `
<ul><li  class="flex items-baseline border-b py-6">
  <a href="/library/acme-9" class="group">
    <div title="acme-9"><h2><div><span class="group-hover:underline truncate">acme-9</span></div></h2>
    <p class="max-w-lg break-words text-neutral-800 text-md">Acme&nbsp;model</p></div>
    <div><div>
      <span  class="inline-flex items-center rounded-md">tools</span>
      <span  class="inline-flex items-center rounded-md">thinking</span>
      <span class="inline-flex items-center rounded-md">8b</span>
    </div>
    <p><span class="flex items-center"><span >1.2M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
    <span class="flex items-center" title="Aug 19, 2026 6:06 PM UTC"><span >1 month ago</span></span></p></div>
  </a></li></ul>`;

const TAGS_HTML = `
<div class="group px-4 py-3"><a href="/library/acme-9:latest" class="md:hidden"></a>
  <a href="/library/acme-9:latest" class="group-hover:underline">acme-9:latest</a>
  <span class="font-mono">aaaaaaaaaaaa</span> • 5.2GB • 40K context window • Text input</div>
<div class="group px-4 py-3"><a href="/library/acme-9:8b" class="group-hover:underline">acme-9:8b</a>
  <span class="font-mono">aaaaaaaaaaaa</span> • 5.2GB • 40K context window • Text, Image input</div>
<div class="group px-4 py-3"><a href="/library/acme-9:8b-cloud" class="x">acme-9:8b-cloud</a> • 0GB</div>
<div class="group px-4 py-3"><a href="/library/acme-9:30b-a3b-q4_K_M" class="x">x</a>
  <span class="font-mono">bbbbbbbbbbbb</span> • 18GB • 256K context window • Text input</div>
<div class="group px-4 py-3"><a href="/library/acme-9:8b-q2_K" class="x">x</a>
  <span class="font-mono">cccccccccccc</span> • 3.1GB • 40K context window • Text input</div>`;

describe('source Ollama', () => {
  it('compteurs de pulls', () => {
    expect(parseCount('46.8K')).toBe(46800);
    expect(parseCount('1.2M')).toBe(1_200_000);
    expect(parseCount('x')).toBeUndefined();
  });
  it('page bibliothèque : nom, badges, pulls, date de mise à jour', () => {
    const [e] = parseOllamaLibrary(LIB_HTML);
    expect(e).toMatchObject({ name: 'acme-9', pulls: 1_200_000, updatedIso: '2026-08-19T18:06:00.000Z' });
    expect(e!.badges).toEqual(expect.arrayContaining(['tools', 'thinking', '8b']));
  });
  it('page des tags → modèles : taille, contexte, MoE, doublon `latest`, cloud et Q2 écartés', () => {
    const entry = parseOllamaLibrary(LIB_HTML)[0]!;
    const rows = parseOllamaTags(TAGS_HTML);
    const models = rows.map((r) => ollamaModelFromTag(entry, r, NOW, rows)).filter(Boolean);
    expect(models.map((m) => m!.name)).toEqual(['acme-9:8b', 'acme-9:30b-a3b-q4_K_M']);
    expect(models[0]).toMatchObject({ runtime: 'ollama', sizeGB: 5.2, contextLength: 40 * 1024, provider: 'Acme', installCommand: 'ollama pull acme-9:8b' });
    expect(models[0]!.capabilities).toEqual(expect.arrayContaining(['tools', 'thinking', 'vision']));
    expect(models[1]).toMatchObject({ paramsB: 30, activeParamsB: 3, quantization: 'Q4_K_M' });
  });
});

describe('source Hugging Face / MLX', () => {
  const base = { id: 'mlx-community/Foo-27B-4bit', downloads: 5000, likes: 80, createdAt: '2026-08-01T00:00:00Z', lastModified: '2026-09-01T00:00:00Z', pipeline_tag: 'text-generation', tags: ['mlx', 'base_model:Qwen/Foo-27B', 'base_model:quantized:Qwen/Foo-27B', '4-bit', 'tool-use'], safetensors: { parameters: { U32: 27e9 }, total: 27e9 } };
  it('MLX : runtime, fournisseur d’origine, taille quantifiée, commande', () => {
    const m = parseHfModel(base, 'mlx', NOW)!;
    expect(m).toMatchObject({ runtime: 'mlx', provider: 'Qwen', publisher: 'mlx-community', format: 'mlx', quantization: '4-bit', installCommand: 'hf download mlx-community/Foo-27B-4bit' });
    expect(m.sizeGB).toBeGreaterThan(12);
    expect(m.sizeGB).toBeLessThan(16);
    expect(m.capabilities).toContain('tools');
  });
  it('fine-tunes, merges, adaptateurs, dépôts de test et gated écartés', () => {
    expect(isReferenceModel({ ...base, tags: ['base_model:finetune:Qwen/x'] })).toBe(false);
    expect(isReferenceModel({ ...base, id: 'someone/foo-lora' })).toBe(false);
    expect(isReferenceModel({ ...base, id: 'someone/tiny-random-x' })).toBe(false);
    expect(isReferenceModel({ ...base, id: 'random-user/Foo-AWQ', tags: ['base_model:quantized:Qwen/Foo'] })).toBe(false);
    expect(parseHfModel({ ...base, gated: 'manual' }, 'mlx', NOW)).toBeNull();
  });
  it('taille inconnue reste inconnue', () => {
    expect(parseHfModel({ ...base, safetensors: undefined }, 'mlx', NOW)!.sizeGB).toBeUndefined();
  });
  it('requêtes MLX limitées à mlx-community', () => {
    expect(hfQueryUrls('mlx').every((u) => u.includes('author=mlx-community'))).toBe(true);
    expect(hfQueryUrls('huggingface').some((u) => u.includes('author='))).toBe(false);
  });
});

describe('catalogue : cache et rafraîchissement', () => {
  const cfg = defaultCfg();
  const path = () => join(mkdtempSync(join(tmpdir(), 'cb-cache-')), 'cache.json');
  const source = (calls: { n: number }, fail = () => false): CatalogSource => ({
    id: 'ollama',
    async fetch() {
      calls.n++;
      if (fail()) throw new Error('hors ligne');
      return [mk({ name: `m${calls.n}` })];
    },
  });

  it('cache frais : une seule requête ; refresh force ; expire après le TTL', async () => {
    const calls = { n: 0 };
    const cachePath = path();
    const opts = { cachePath, sources: [source(calls)] };
    await loadCatalog(cfg, apple16, { ...opts, now: NOW });
    await loadCatalog(cfg, apple16, { ...opts, now: NOW + 3_600_000 });
    expect(calls.n).toBe(1);
    await loadCatalog(cfg, apple16, { ...opts, now: NOW, refresh: true });
    expect(calls.n).toBe(2);
    await loadCatalog(cfg, apple16, { ...opts, now: NOW + 25 * 3_600_000 });
    expect(calls.n).toBe(3);
  });
  it('réseau en panne : repli sur le cache périmé, signalé', async () => {
    const calls = { n: 0 };
    let down = false;
    const cachePath = path();
    const opts = { cachePath, sources: [source(calls, () => down)] };
    await loadCatalog(cfg, apple16, { ...opts, now: NOW });
    down = true;
    const cat = await loadCatalog(cfg, apple16, { ...opts, now: NOW + 48 * 3_600_000 });
    expect(cat.models).toHaveLength(1);
    expect(cat.stale).toBe(true);
    expect(cat.errors[0]).toMatchObject({ source: 'ollama' });
  });
  it('source MLX ignorée hors Apple Silicon', async () => {
    const calls = { n: 0 };
    const mlx: CatalogSource = { id: 'mlx', async fetch() { calls.n++; return []; } };
    await loadCatalog(cfg, { appleSilicon: false }, { cachePath: path(), sources: [mlx] });
    expect(calls.n).toBe(0);
  });
  it('registre des modèles installés (relu plus tard par le routeur)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cb-reg-')), 'reg.json');
    const e = { id: 'ollama:a:1b', name: 'a:1b', runtime: 'ollama' as const, provider: 'A', categories: ['general' as const], hardwareFit: 'recommended' as const, tokensPerSecond: 30, installedAt: NOW };
    recordInstalled(e, p);
    recordInstalled({ ...e, tokensPerSecond: 31 }, p);
    expect(readRegistry(p)).toHaveLength(1);
    forgetInstalled('ollama:a:1b', p);
    expect(readRegistry(p)).toEqual([]);
  });
});

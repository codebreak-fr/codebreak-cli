import { describe, expect, it } from 'vitest';
import { evaluateFit } from '../src/catalog/compatibility/evaluator.js';
import { memoryBudget } from '../src/catalog/compatibility/memory.js';
import { classify } from '../src/catalog/categories.js';
import { providerFromFamily, providerFromHf } from '../src/catalog/providers.js';
import { recommendCategory } from '../src/catalog/recommendations.js';
import { parseParams, parseQuant, sizeFromDtypes, sizeFromSiblings } from '../src/catalog/quant.js';
import { appleBandwidth, parseNvidiaSmi, parseRocmSmi } from '../src/detect/hardware.js';
import { apple16, apple8, cpuOnly, cuda24, daysAgo, detWith, dualGpu, mk, NOW } from './catalog-helpers.js';
import { defaultCfg } from './helpers.js';

const cfg = defaultCfg();

describe('détection matérielle', () => {
  it('nvidia-smi : plusieurs GPU, VRAM en Go, bande passante connue', () => {
    const gpus = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3060, 12288\n');
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({ vendor: 'nvidia', vramGB: 24, bandwidthGBps: 1008 });
    expect(gpus[1]!.vramGB).toBe(12);
  });
  it('rocm-smi JSON', () => {
    const gpus = parseRocmSmi(JSON.stringify({ card0: { 'Card Series': 'Radeon RX 7900 XTX', 'VRAM Total Memory (B)': String(24 * 1024 ** 3) } }));
    expect(gpus).toEqual([{ name: 'Radeon RX 7900 XTX', vendor: 'amd', vramGB: 24 }]);
  });
  it('bande passante Apple par puce ; inconnue → undefined', () => {
    expect(appleBandwidth('Apple M4')).toBe(120);
    expect(appleBandwidth('Apple M4 Max', 40)).toBe(546);
    expect(appleBandwidth('Apple M4 Max', 32)).toBe(410);
    expect(appleBandwidth('Intel Core i9')).toBeUndefined();
  });
  it('budget mémoire : unifiée, VRAM (multi-GPU pénalisé), RAM', () => {
    expect(memoryBudget(apple16, cfg)).toEqual({ pool: 'unified', budgetGB: 16 * 0.7 });
    expect(memoryBudget(cuda24, cfg)).toEqual({ pool: 'vram', budgetGB: 24 });
    expect(memoryBudget(dualGpu, cfg)).toEqual({ pool: 'vram', budgetGB: 24 * 0.9 });
    expect(memoryBudget(cpuOnly, cfg)).toEqual({ pool: 'ram', budgetGB: 16 });
  });
});

describe('compatibilité matériel × modèle', () => {
  const fit = (sizeGB: number, hw = cuda24, over = {}) => evaluateFit(mk({ sizeGB, paramsB: sizeGB / 0.6, ...over }), 'general', hw, cfg);

  it('modèle confortable → recommandé', () => {
    expect(fit(4).verdict).toBe('recommended');
  });
  it('modèle limite (peu de marge) → jamais recommandé', () => {
    const f = fit(15);
    expect(['alternative', 'slow']).toContain(f.verdict);
    expect(f.memory.neededGB + f.memory.headroomGB).toBeLessThanOrEqual(f.memory.budgetGB * 1.0001 + f.memory.headroomGB / 2);
  });
  it('modèle trop lourd → exclu, sans offload partiel', () => {
    expect(fit(30)).toMatchObject({ verdict: 'excluded', reason: 'too-heavy' });
    expect(fit(24)).toMatchObject({ verdict: 'excluded' }); // « tient pile » = OOM potentiel
  });
  it('la marge de sécurité est exigée : besoin + marge doit tenir', () => {
    const f = fit(19); // ~ 19 + kv + overhead ≈ 21 Go sur 24
    expect(f.verdict === 'excluded' || f.verdict === 'slow').toBe(true);
  });
  it('RAM faible : un gros modèle est exclu, un petit passe', () => {
    expect(evaluateFit(mk({ sizeGB: 6, paramsB: 10 }), 'general', apple8, cfg).verdict).toBe('excluded');
    expect(evaluateFit(mk({ sizeGB: 1.5, paramsB: 2.5 }), 'general', apple8, cfg).verdict).not.toBe('excluded');
  });
  it('débit trop faible → 🐢 puis exclu', () => {
    const slowGpu = { ...cuda24, bandwidthGBps: 40 }; // ~24 Go/s utiles
    expect(evaluateFit(mk({ sizeGB: 3, paramsB: 5 }), 'general', slowGpu, cfg).verdict).toBe('slow'); // ~8 tok/s
    expect(evaluateFit(mk({ sizeGB: 8, paramsB: 13 }), 'general', slowGpu, cfg)).toMatchObject({ verdict: 'excluded', reason: 'too-slow' }); // ~3 tok/s
  });
  it('CPU seul : vitesse invérifiable → plafonné à « alternative » ; image/vidéo exclues', () => {
    expect(evaluateFit(mk({ sizeGB: 3, paramsB: 5 }), 'general', cpuOnly, cfg).verdict).toBe('alternative');
    expect(evaluateFit(mk({ sizeGB: 3 }), 'image', cpuOnly, cfg)).toMatchObject({ verdict: 'excluded', reason: 'wrong-hardware' });
  });
  it('taille inconnue → exclu (jamais inventée)', () => {
    expect(evaluateFit(mk({ sizeGB: undefined }), 'general', cuda24, cfg)).toMatchObject({ verdict: 'excluded', reason: 'unknown-size' });
  });
  it('MoE : le débit se base sur les paramètres actifs', () => {
    const dense = evaluateFit(mk({ sizeGB: 10, paramsB: 16 }), 'general', cuda24, cfg).performance!.value!;
    const moe = evaluateFit(mk({ sizeGB: 10, paramsB: 16, activeParamsB: 3 }), 'general', cuda24, cfg).performance!.value!;
    expect(moe).toBeGreaterThan(dense * 4);
  });
  it('les seuils sont configurables', () => {
    const strict = { ...cfg, discovery: { ...cfg.discovery, comfort_ratio: 0.05 } };
    expect(evaluateFit(mk({ sizeGB: 4 }), 'general', cuda24, strict).verdict).not.toBe('recommended');
  });
  it('pile mémoire propre à la catégorie : la diffusion réserve plus que le LLM', () => {
    const llm = evaluateFit(mk({ sizeGB: 4 }), 'general', cuda24, cfg).memory.overheadGB;
    const img = evaluateFit(mk({ sizeGB: 4 }), 'image', cuda24, cfg).memory.overheadGB;
    expect(img).toBeGreaterThan(llm);
  });
});

describe('recommandations : fournisseurs, slow, modernité', () => {
  const det = detWith(cuda24);
  const rec = (models: ReturnType<typeof mk>[]) => recommendCategory(models, 'general', det, cfg, NOW, '/nonexistent');

  it('jamais deux modèles du même fournisseur dans une catégorie', () => {
    const r = rec([
      mk({ name: 'qwen-a:8b', provider: 'Qwen', sizeGB: 5, paramsB: 8 }),
      mk({ name: 'qwen-b:14b', provider: 'Qwen', sizeGB: 9, paramsB: 14 }),
      mk({ name: 'mistral-a:8b', provider: 'Mistral', sizeGB: 5, paramsB: 8 }),
      mk({ name: 'deepseek-a:8b', provider: 'DeepSeek', sizeGB: 5, paramsB: 8 }),
    ]);
    const providers = [...r.recommended, ...(r.slow ? [r.slow] : [])].map((x) => x.model.provider);
    expect(new Set(providers).size).toBe(providers.length);
    expect(providers.filter((p) => p === 'Qwen')).toHaveLength(1);
    expect(r.recommended.length).toBe(3);
  });
  it('la casse et la graphie du fournisseur ne contournent pas la règle', () => {
    const r = rec([mk({ provider: 'Qwen' }), mk({ provider: 'qwen' }), mk({ provider: 'QWEN ' })]);
    expect(r.recommended).toHaveLength(1);
  });
  it('3 recommandés maximum', () => {
    const r = rec(['A', 'B', 'C', 'D', 'E'].map((p) => mk({ provider: p })));
    expect(r.recommended).toHaveLength(3);
  });
  it('ne remplit jamais artificiellement la liste', () => {
    expect(rec([mk({ provider: 'A' }), mk({ provider: 'B' })]).recommended).toHaveLength(2);
    expect(rec([]).recommended).toHaveLength(0);
  });
  it('au plus UN 🐢, d’un fournisseur absent de la sélection', () => {
    const slowGpu = detWith({ ...cuda24, bandwidthGBps: 40 });
    const models = [
      mk({ provider: 'A', sizeGB: 1.2, paramsB: 2 }), // rapide
      mk({ provider: 'B', sizeGB: 3, paramsB: 5 }), // ~8 tok/s → slow
      mk({ provider: 'C', sizeGB: 3.2, paramsB: 5 }), // slow
      mk({ provider: 'D', sizeGB: 3.4, paramsB: 5 }), // slow
    ];
    const r = recommendCategory(models, 'general', slowGpu, cfg, NOW, '/nonexistent');
    expect(r.recommended.map((x) => x.model.provider)).toEqual(['A']);
    expect(r.slow?.verdict).toBe('slow');
    expect(r.recommended.every((x) => x.verdict !== 'slow')).toBe(true);
    expect([r.slow].filter(Boolean)).toHaveLength(1);
  });
  it('le 🐢 n’est pas d’un fournisseur déjà recommandé', () => {
    const slowGpu = detWith({ ...cuda24, bandwidthGBps: 40 });
    const models = [mk({ provider: 'A', sizeGB: 1.2, paramsB: 2 }), mk({ provider: 'A', sizeGB: 3, paramsB: 5 })];
    const r = recommendCategory(models, 'general', slowGpu, cfg, NOW, '/nonexistent');
    expect(r.recommended).toHaveLength(1);
    expect(r.slow).toBeNull();
  });
  it('un modèle ancien est écarté même très populaire ; un récent sans traction aussi', () => {
    const r = rec([
      mk({ provider: 'Old', releaseDate: daysAgo(900), lastUpdated: daysAgo(900), downloads: 90_000_000 }),
      mk({ provider: 'Nobody', downloads: 3, likes: 0 }),
      mk({ provider: 'Good' }),
    ]);
    expect(r.recommended.map((x) => x.model.provider)).toEqual(['Good']);
    expect(r.excludedReasons).toMatchObject({ stale: 1, 'low-signal': 1 });
  });
  it('la fraîcheur et la qualité (pas seulement la date) départagent', () => {
    const r = rec([
      mk({ provider: 'FreshTiny', paramsB: 0.5, sizeGB: 0.4, releaseDate: daysAgo(5), downloads: 800 }),
      mk({ provider: 'SolidBig', paramsB: 14, sizeGB: 9, releaseDate: daysAgo(120), downloads: 2_000_000 }),
    ]);
    expect(r.recommended[0]!.model.provider).toBe('SolidBig');
  });
  it('un runtime absent exclut le modèle (installable automatiquement seulement)', () => {
    const noOllama = detWith(cuda24, { ollama: { ...det.ollama, installed: false } });
    const r = recommendCategory([mk()], 'general', noOllama, cfg, NOW, '/nonexistent');
    expect(r.recommended).toHaveLength(0);
    expect(r.excludedReasons['runtime-missing']).toBe(1);
  });
  it('les raisons et signaux sont fournis', () => {
    const r = rec([mk({ capabilities: ['tools'] })]);
    expect(r.recommended[0]!.why.join(' ')).toMatch(/mémoire/);
    expect(r.recommended[0]!.why.join(' ')).toMatch(/outils/);
    expect(r.recommended[0]!.signals.length).toBeGreaterThan(0);
  });
});

describe('métadonnées', () => {
  it('quantification, paramètres, MoE', () => {
    expect(parseQuant('qwen3:8b-q4_K_M').bits).toBe(4);
    expect(parseQuant('Model-4bit').label).toBe('4-bit');
    expect(parseQuant('x-bf16').bits).toBe(16);
    expect(parseParams('30b-a3b')).toEqual({ paramsB: 30, activeParamsB: 3 });
    expect(parseParams('270m').paramsB).toBeCloseTo(0.27);
  });
  it('taille des poids depuis les dtypes et depuis les fichiers', () => {
    expect(sizeFromDtypes({ BF16: 1e9 })).toBeCloseTo((1e9 * 2) / 1024 ** 3, 3);
    expect(sizeFromDtypes({ U32: 8e9 }, 4)).toBeGreaterThan(3.5); // 4 bits ≈ 0,54 o/param
    expect(
      sizeFromSiblings([
        { rfilename: 'model_index.json', size: 500 },
        { rfilename: 'flux.safetensors', size: 24e9 }, // doublon monolithique ignoré
        { rfilename: 'transformer/a.safetensors', size: 10e9 },
        { rfilename: 'vae/b.safetensors', size: 1e9 },
      ]),
    ).toBeCloseTo(11e9 / 1024 ** 3, 3);
  });
  it('fournisseur : organisation d’origine plutôt que le republieur', () => {
    expect(providerFromHf('mlx-community/Foo-4bit', ['base_model:Qwen/Foo'])).toBe('Qwen');
    expect(providerFromHf('mlx-community/Foo-4bit', ['base_model:quantized:mistralai/Foo'])).toBe('Mistral');
    expect(providerFromHf('deepseek-ai/Bar')).toBe('DeepSeek');
    expect(providerFromFamily('qwen3-coder:30b')).toBe('Qwen');
    expect(providerFromFamily('gemma4:e2b')).toBe('Google');
    expect(providerFromFamily('newvendor-1.5')).toBe('Newvendor');
  });
  it('classification par métadonnées', () => {
    expect(classify({ name: 'x-embed', capabilities: ['embedding'] })).toEqual(['embeddings']);
    expect(classify({ name: 'whisper', pipeline: 'automatic-speech-recognition' })).toEqual(['stt']);
    expect(classify({ name: 'qwen3-coder:30b', capabilities: ['tools'] })).toEqual(expect.arrayContaining(['coding', 'agents']));
    expect(classify({ name: 'x-vl', pipeline: 'image-text-to-text' })).toContain('vision');
    expect(classify({ name: 'deepseek-ocr', capabilities: ['vision'] })).toContain('ocr');
  });
});

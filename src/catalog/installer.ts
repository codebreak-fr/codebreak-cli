import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import type { Detection } from '../detect/types.js';
import { modelRoots, scanHfCache } from '../detect/inventory.js';
import { classify, guessCategory } from './categories.js';
import { dirSizeGB, hfCacheDir, hfRepoDir } from './installed.js';
import type { Capability, CatalogModel, CategoryId, Runtime } from './types.js';
import { t } from '../i18n/index.js';

/** Ce qu'il faut savoir d'un modèle pour l'installer ou le supprimer (le catalogue est facultatif). */
export type ModelRef = Pick<CatalogModel, 'runtime' | 'name'> & Partial<Pick<CatalogModel, 'sizeGB'>>;

/** Modèle présent sur la machine, quel que soit l'outil qui le stocke. */
export interface InstalledModel {
  runtime: Runtime | 'app';
  name: string;
  sizeGB: number;
  /** où il vit : « Ollama », « Hugging Face », « MacWhisper »… */
  store: string;
  /** dossier à supprimer (absent pour Ollama, qui a sa propre commande) */
  path?: string;
  category?: CategoryId;
}

/** Cible d'une suppression : un modèle installé (catalogue ou inventaire). */
export type RemoveRef = { runtime: Runtime | 'app'; name: string; sizeGB?: number; path?: string };

export type Plan =
  | { ok: true; runtime: Runtime | 'app'; name: string; display: string; argv: string[]; sizeGB?: number }
  | { ok: false; runtime: Runtime | 'app'; name: string; error: string };

export type RemovePlan =
  | { ok: true; runtime: Runtime | 'app'; name: string; display: string; argv?: string[]; dir?: string; freedGB?: number }
  | { ok: false; runtime: Runtime | 'app'; name: string; error: string };

/** Résout le modèle vers la commande de son runtime. Ajouter un runtime = un cas ici. */
export function planInstall(model: Pick<RemoveRef, 'runtime' | 'name' | 'sizeGB'>, det: Detection): Plan {
  const base = { runtime: model.runtime, name: model.name };
  switch (model.runtime) {
    case 'app':
      return { ...base, ok: false, error: t('Ce modèle est géré par son application.') };
    case 'ollama': {
      if (!det.ollama.installed || !det.ollama.path) return { ...base, ok: false, error: t('Ollama n’est pas installé (https://ollama.com/download).') };
      return { ...base, ok: true, argv: [det.ollama.path, 'pull', model.name], display: `ollama pull ${model.name}`, sizeGB: model.sizeGB };
    }
    case 'mlx':
    case 'huggingface': {
      if (!det.huggingface.installed || !det.huggingface.path) return { ...base, ok: false, error: t('Le CLI `hf` est requis : pip install -U "huggingface_hub[cli]".') };
      if (model.runtime === 'mlx' && !det.hardware.appleSilicon) return { ...base, ok: false, error: t('MLX nécessite un Mac Apple Silicon.') };
      return { ...base, ok: true, argv: [det.huggingface.path, 'download', model.name], display: `hf download ${model.name}`, sizeGB: model.sizeGB };
    }
  }
}

/** Suppression : `ollama rm` pour Ollama, purge du dossier du modèle sinon (cache HF, MacWhisper, LM Studio, oMLX). */
export function planRemove(model: RemoveRef, det: Detection, hfRoot = hfCacheDir()): RemovePlan {
  const base = { runtime: model.runtime, name: model.name };
  if (model.runtime === 'ollama') {
    if (!det.ollama.installed || !det.ollama.path) return { ...base, ok: false, error: t('Ollama est introuvable.') };
    const known = det.ollama.models.find((m) => m.name === model.name);
    return { ...base, ok: true, argv: [det.ollama.path, 'rm', model.name], display: `ollama rm ${model.name}`, freedGB: known?.sizeGB ?? model.sizeGB };
  }
  const dir = model.path ?? hfRepoDir(model.name, hfRoot);
  if (!existsSync(dir)) return { ...base, ok: false, error: t('Ce modèle est introuvable sur le disque.') };
  return { ...base, ok: true, dir, display: t('supprimer {dir}', { dir }), freedGB: Math.round(dirSizeGB(dir) * 10) / 10 };
}

/** Catégorie d'un modèle Ollama installé : capacités déclarées, sinon nom. */
function ollamaCategory(m: Detection['ollama']['models'][number]): CategoryId | undefined {
  const caps = m.capabilities.filter((c): c is Capability => c === 'tools' || c === 'vision' || c === 'thinking' || c === 'embedding');
  return classify({ name: m.name, capabilities: caps }).find((c) => c !== 'agents' && c !== 'rag') ?? guessCategory(m.name);
}

/**
 * Tous les modèles présents sur la machine : Ollama (via la détection) + cache Hugging Face + dossiers d'apps
 * (MacWhisper, LM Studio, oMLX) recensés par l'inventaire.
 */
export function listInstalled(det: Detection, hfRoot = hfCacheDir()): InstalledModel[] {
  const ollama = det.ollama.models.map((m) => ({ runtime: 'ollama' as const, name: m.name, sizeGB: m.sizeGB, store: 'Ollama', category: ollamaCategory(m) }));
  const hf = scanHfCache(hfRoot).map((m) => ({ runtime: m.runtime, name: m.name, sizeGB: m.sizeGB, store: m.store, path: m.path, category: m.category }));
  const apps = det.inventory.models.filter((m) => m.store !== 'Hugging Face').map((m) => ({ runtime: m.runtime, name: m.name, sizeGB: m.sizeGB, store: m.store, path: m.path, category: m.category }));
  return [...ollama, ...hf, ...apps];
}

export interface RunResult {
  ok: boolean;
  message: string;
}

/** Dernier pourcentage annoncé dans un flux de progression (`ollama pull`, barres tqdm de `hf`). */
export function parsePercent(chunk: string): number | undefined {
  const all = [...chunk.matchAll(/(\d{1,3})%/g)];
  const last = all.at(-1);
  if (!last) return undefined;
  const n = Number(last[1]);
  return n >= 0 && n <= 100 ? n : undefined;
}

/** Lance la commande d'installation, remonte la progression, interrompable par `signal`. */
export function runInstall(plan: Extract<Plan, { ok: true }>, opts: { signal?: AbortSignal; onProgress?: (percent: number | undefined, text: string) => void } = {}): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(plan.argv[0]!, plan.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal, env: process.env });
    let tail = '';
    const onData = (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-600);
      const line = text.split(/[\r\n]+/).filter(Boolean).at(-1) ?? '';
      opts.onProgress?.(parsePercent(text), line.trim().slice(0, 100));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => done({ ok: false, message: opts.signal?.aborted ? t('Installation interrompue.') : String(e.message) }));
    child.on('close', (code) => {
      if (opts.signal?.aborted) return done({ ok: false, message: t('Installation interrompue.') });
      const last = tail.split(/[\r\n]+/).filter(Boolean).at(-1) ?? '';
      done(code === 0 ? { ok: true, message: t('Installé.') } : { ok: false, message: t('Échec (code {code}) : {v}', { code, v: last.trim() }) });
    });
  });
}

/** Garde-fou : on ne supprime qu'un dossier STRICTEMENT à l'intérieur d'une racine de modèles connue (jamais la racine). */
function safeDir(dir: string, roots: string[]): boolean {
  const abs = resolve(dir);
  return roots.some((root) => {
    const r = resolve(root);
    if (!abs.startsWith(r + sep)) return false;
    // cache Hugging Face : uniquement un dépôt `models--*` directement sous la racine
    return r !== resolve(hfCacheDir()) || (dirname(abs) === r && basename(abs).startsWith('models--'));
  });
}

export function runRemove(plan: Extract<RemovePlan, { ok: true }>, roots: string | string[] = modelRoots()): Promise<RunResult> {
  if (plan.dir) {
    const allowed = Array.isArray(roots) ? roots : [roots];
    if (!safeDir(plan.dir, allowed)) return Promise.resolve({ ok: false, message: t('Chemin refusé : {dir}', { dir: plan.dir }) });
    try {
      rmSync(plan.dir, { recursive: true, force: true });
      return Promise.resolve({ ok: true, message: t('Supprimé.') });
    } catch (e) {
      return Promise.resolve({ ok: false, message: (e as Error).message });
    }
  }
  return new Promise((done) => {
    const child = spawn(plan.argv![0]!, plan.argv!.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done({ ok: false, message: e.message }));
    child.on('close', (code) => done(code === 0 ? { ok: true, message: t('Supprimé.') } : { ok: false, message: t('Échec (code {code}) : {v}', { code, v: err.trim().split('\n').at(-1) ?? '' }) }));
  });
}

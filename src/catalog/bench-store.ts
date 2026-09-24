import { benchCachePath } from '../config/paths.js';
import { readJson, writeJson } from '../util/store.js';

/** Mesure réelle d'un modèle sur CETTE machine (jamais une estimation). */
export interface BenchResult {
  /** clé stable : machine × runtime × modèle */
  key: string;
  runtime: string;
  model: string;
  machine: string;
  at: number;
  loadMs?: number;
  tokensPerSecond?: number;
  promptTokensPerSecond?: number;
  contextLength?: number;
  toolCalling?: 'yes' | 'no' | 'unknown';
  /** stabilité : exécutions réussies / tentées */
  stability?: { ok: number; runs: number };
  coding?: { passed: number; total: number; ms: number };
  error?: string;
}

export const benchKey = (machine: string, runtime: string, model: string) => `${machine}|${runtime}|${model}`;

export const readBench = (path = benchCachePath()): BenchResult[] => readJson<BenchResult[]>(path, []);

export function saveBench(r: BenchResult, path = benchCachePath()): void {
  writeJson(path, [...readBench(path).filter((x) => x.key !== r.key), r]);
}

export const findBench = (key: string, path = benchCachePath()): BenchResult | undefined => readBench(path).find((x) => x.key === key);

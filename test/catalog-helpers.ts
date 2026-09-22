import type { CatalogModel } from '../src/catalog/types.js';
import type { Detection, HardwareInfo } from '../src/detect/types.js';
import { detection } from './helpers.js';

export const NOW = Date.parse('2026-09-24T12:00:00Z');
export const daysAgo = (d: number) => new Date(NOW - d * 864e5).toISOString();

export function hw(over: Partial<HardwareInfo> = {}): HardwareInfo {
  return { ...detection.hardware, ...over };
}

/** Apple Silicon 16 Go (bande passante 120 Go/s) — budget ≈ 11,2 Go avec le ratio par défaut. */
export const apple16 = hw({ memoryGB: 16 });
export const apple8 = hw({ memoryGB: 8, chip: 'Apple M1', bandwidthGBps: 68 });
export const cuda24 = hw({ platform: 'linux', arch: 'x64', chip: 'AMD Ryzen', appleSilicon: false, mlx: { supported: false, pythonMlx: false, pythonMlxLm: false }, memoryGB: 64, gpus: [{ name: 'RTX 4090', vendor: 'nvidia', vramGB: 24, bandwidthGBps: 1008 }], backend: 'cuda', vramGB: 24, bandwidthGBps: 1008 });
export const dualGpu = hw({ ...cuda24, gpus: [{ name: 'RTX 3060', vendor: 'nvidia', vramGB: 12, bandwidthGBps: 360 }, { name: 'RTX 3060', vendor: 'nvidia', vramGB: 12, bandwidthGBps: 360 }], vramGB: 24, bandwidthGBps: 360 });
export const cpuOnly = hw({ platform: 'linux', arch: 'x64', chip: 'Intel', appleSilicon: false, mlx: { supported: false, pythonMlx: false, pythonMlxLm: false }, memoryGB: 32, gpus: [], backend: 'cpu', vramGB: 0, bandwidthGBps: undefined });

export const detWith = (hardware: HardwareInfo, over: Partial<Detection> = {}): Detection => ({ ...detection, hardware, ollama: { ...detection.ollama, path: '/bin/ollama' }, ...over });

let n = 0;
export function mk(over: Partial<CatalogModel> = {}): CatalogModel {
  const id = over.id ?? `ollama:model-${++n}`;
  return {
    id,
    name: over.name ?? id.replace('ollama:', ''),
    provider: 'Qwen',
    publisher: 'ollama',
    categories: ['general'],
    capabilities: [],
    paramsB: 8,
    format: 'gguf',
    runtime: 'ollama',
    sizeGB: 5,
    sizeSource: 'registry',
    releaseDate: daysAgo(60),
    lastUpdated: daysAgo(30),
    downloads: 100_000,
    likes: 500,
    source: 'ollama',
    sourceUrl: 'https://example.test',
    fetchedAt: NOW,
    installCommand: 'ollama pull x',
    ...over,
  };
}

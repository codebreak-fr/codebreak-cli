import { cpus, totalmem, freemem } from 'node:os';
import { exec } from '../util/exec.js';
import type { GpuBackend, GpuInfo, HardwareInfo } from './types.js';
import { t } from '../i18n/index.js';

const GB = 1024 ** 3;

/** Mémoire réellement disponible (libre + inactive + spéculative + purgeable) d'après vm_stat. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const free = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  return (free * pageSize) / GB;
}

export function parsePmset(batt: string, all: string): { onBattery: boolean; lowPowerMode: boolean } {
  return {
    onBattery: /Now drawing from 'Battery Power'/.test(batt),
    lowPowerMode: /lowpowermode\s+1/.test(all),
  };
}

export function classifyMemory(memGB: number): HardwareInfo['tier'] {
  if (memGB < 12) return 'small';
  if (memGB < 24) return 'medium';
  if (memGB < 48) return 'large';
  return 'xl';
}

/** Taille approximative (Go de poids Q4) d'un modèle de N milliards de paramètres. */
export const q4SizeGB = (paramsB: number) => paramsB * 0.6;

export function buildRecommendation(h: Pick<HardwareInfo, 'localBudgetGB' | 'appleSilicon' | 'memoryGB'>): string {
  const maxB = Math.floor(h.localBudgetGB / 0.6);
  const engine = h.appleSilicon ? t('accélération Metal/MLX') : t('CPU (pas d’accélération Apple)');
  return t('Modèles locaux jusqu’à ~{v} Go (≈ {maxB}B en Q4), {engine}', { v: h.localBudgetGB.toFixed(0), maxB, engine });
}

/** Bande passante mémoire (Go/s) des puces Apple d'après leur nom ; `undefined` si le modèle est inconnu. */
export function appleBandwidth(chip: string, gpuCores?: number): number | undefined {
  const m = /Apple M(\d)(?:\s+(Pro|Max|Ultra))?/i.exec(chip);
  if (!m) return undefined;
  const gen = Number(m[1]);
  const tier = (m[2] ?? 'base').toLowerCase();
  const table: Record<number, Record<string, number>> = {
    1: { base: 68, pro: 200, max: 400, ultra: 800 },
    2: { base: 100, pro: 200, max: 400, ultra: 800 },
    3: { base: 100, pro: 150, max: 400, ultra: 819 },
    4: { base: 120, pro: 273, max: 546, ultra: 819 },
    5: { base: 153, pro: 307, max: 614, ultra: 819 },
  };
  const v = table[gen]?.[tier];
  if (!v) return undefined;
  // M3/M4 Max « allégés » (GPU 30/32 cœurs) : bus mémoire plus étroit
  if (tier === 'max' && gpuCores && gpuCores <= 32) return gen === 4 ? 410 : gen === 3 ? 300 : v;
  return v;
}

/** Bande passante (Go/s) de quelques GPU NVIDIA courants ; `undefined` si inconnu. */
export function nvidiaBandwidth(name: string): number | undefined {
  const table: [RegExp, number][] = [
    [/5090/, 1792], [/5080/, 960], [/5070 Ti/i, 896], [/5070/, 672], [/5060 Ti/i, 448],
    [/4090/, 1008], [/4080/, 717], [/4070 Ti/i, 504], [/4070/, 504], [/4060 Ti/i, 288], [/4060/, 272],
    [/3090/, 936], [/3080/, 760], [/3070/, 448], [/3060/, 360],
  ];
  return table.find(([re]) => re.test(name))?.[1];
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` → GPU. */
export function parseNvidiaSmi(text: string): GpuInfo[] {
  return text
    .split('\n')
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((c) => c.length >= 2 && c[0] && Number.isFinite(Number(c[1])))
    .map(([name, mib]) => ({
      name: name!,
      vendor: 'nvidia' as const,
      vramGB: Math.round((Number(mib) / 1024) * 10) / 10,
      bandwidthGBps: nvidiaBandwidth(name!),
    }));
}

/** `rocm-smi --showproductname --showmeminfo vram --json` → GPU. */
export function parseRocmSmi(text: string): GpuInfo[] {
  try {
    const j = JSON.parse(text) as Record<string, Record<string, string>>;
    return Object.entries(j)
      .filter(([k]) => /^card\d+/.test(k))
      .map(([, v]) => ({
        name: v['Card Series'] ?? v['Card series'] ?? v['Card model'] ?? 'AMD GPU',
        vendor: 'amd' as const,
        vramGB: v['VRAM Total Memory (B)'] ? Math.round((Number(v['VRAM Total Memory (B)']) / GB) * 10) / 10 : undefined,
      }));
  } catch {
    return [];
  }
}

async function detectDiscreteGpus(): Promise<GpuInfo[]> {
  const [nv, amd] = await Promise.all([
    exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 4000 }),
    exec('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], { timeoutMs: 4000 }),
  ]);
  return [...(nv.code === 0 ? parseNvidiaSmi(nv.stdout) : []), ...(amd.code === 0 ? parseRocmSmi(amd.stdout) : [])];
}

async function sysctl(key: string): Promise<string> {
  const r = await exec('sysctl', ['-n', key], { timeoutMs: 2000 });
  return r.code === 0 ? r.stdout.trim() : '';
}

export async function detectHardware(memoryRatio = 0.5): Promise<HardwareInfo> {
  const platform = process.platform;
  const arch = process.arch;
  const isMac = platform === 'darwin';
  const appleSilicon = isMac && arch === 'arm64';

  const [brand, memsize, perf, eff, vm, batt, pmAll, gpu, py, discrete] = await Promise.all([
    isMac ? sysctl('machdep.cpu.brand_string') : Promise.resolve(''),
    isMac ? sysctl('hw.memsize') : Promise.resolve(''),
    isMac ? sysctl('hw.perflevel0.physicalcpu') : Promise.resolve(''),
    isMac ? sysctl('hw.perflevel1.physicalcpu') : Promise.resolve(''),
    isMac ? exec('vm_stat', [], { timeoutMs: 2000 }) : Promise.resolve(null),
    isMac ? exec('pmset', ['-g', 'batt'], { timeoutMs: 2000 }) : Promise.resolve(null),
    isMac ? exec('pmset', ['-g'], { timeoutMs: 2000 }) : Promise.resolve(null),
    appleSilicon ? exec('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 6000 }) : Promise.resolve(null),
    exec(
      'python3',
      ['-c', "import importlib.util as u;print(int(u.find_spec('mlx') is not None),int(u.find_spec('mlx_lm') is not None))"],
      { timeoutMs: 3000 },
    ),
    appleSilicon ? Promise.resolve([] as GpuInfo[]) : detectDiscreteGpus(),
  ]);

  const memoryGB = memsize ? Number(memsize) / GB : totalmem() / GB;
  const freeMemoryGB = (vm && parseVmStat(vm.stdout)) || freemem() / GB;

  let gpuCores: number | undefined;
  if (gpu?.code === 0) {
    try {
      const cores = JSON.parse(gpu.stdout)?.SPDisplaysDataType?.[0]?.sppci_cores;
      if (cores) gpuCores = Number(cores);
    } catch {
      /* ignoré */
    }
  }

  const [pyMlx, pyMlxLm] = py.code === 0 ? py.stdout.trim().split(/\s+/).map((v) => v === '1') : [false, false];
  const power = batt && pmAll ? parsePmset(batt.stdout, pmAll.stdout) : { onBattery: false, lowPowerMode: false };

  const cores = cpus().length;
  const chip = brand || cpus()[0]?.model || `${platform}/${arch}`;
  // sans accélération unifiée, on reste plus prudent
  const ratio = appleSilicon ? memoryRatio : Math.min(memoryRatio, 0.4);
  const localBudgetGB = Math.round(memoryGB * ratio * 10) / 10;

  const gpus = discrete;
  const vramGB = Math.round(gpus.reduce((sum, g) => sum + (g.vramGB ?? 0), 0) * 10) / 10;
  const backend: GpuBackend = appleSilicon ? 'metal' : gpus.some((g) => g.vendor === 'nvidia') ? 'cuda' : gpus.some((g) => g.vendor === 'amd') ? 'rocm' : 'cpu';
  const bandwidthGBps = appleSilicon ? appleBandwidth(chip, gpuCores) : gpus.find((g) => g.bandwidthGBps)?.bandwidthGBps;

  const info: HardwareInfo = {
    platform,
    arch,
    chip,
    cores: {
      total: cores,
      performance: perf ? Number(perf) : undefined,
      efficiency: eff ? Number(eff) : undefined,
    },
    gpuCores,
    memoryGB: Math.round(memoryGB * 10) / 10,
    freeMemoryGB: Math.round(freeMemoryGB * 10) / 10,
    appleSilicon,
    mlx: { supported: appleSilicon, pythonMlx: Boolean(pyMlx), pythonMlxLm: Boolean(pyMlxLm) },
    gpus,
    backend,
    vramGB,
    bandwidthGBps,
    onBattery: power.onBattery,
    lowPowerMode: power.lowPowerMode,
    localBudgetGB,
    tier: classifyMemory(memoryGB),
    recommendation: '',
  };
  info.recommendation = buildRecommendation(info);
  return info;
}

import { cpus, freemem, loadavg } from 'node:os';
import { benchKey, readBench } from '../../catalog/bench-store.js';
import { parseVmStat } from '../../detect/hardware.js';
import { exec } from '../../util/exec.js';
import { type ServiceStatus, type ServiceUsage, type UsageContext, type UsageMetric, type UsageProvider } from '../types.js';

/** Instantané de la machine (mémoire libre, VRAM libre, charge CPU). */
export interface MachineSample {
  ramFreeGB: number;
  vramFreeGB?: number;
  cpuLoad: number;
  at: number;
}

export async function sampleMachine(now = Date.now()): Promise<MachineSample> {
  let ramFree = freemem() / 1024 ** 3;
  if (process.platform === 'darwin') {
    const vm = await exec('vm_stat', [], { timeoutMs: 2000 });
    const v = vm.code === 0 ? parseVmStat(vm.stdout) : null;
    if (v) ramFree = v;
  }
  let vram: number | undefined;
  const nv = await exec('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeoutMs: 3000 });
  if (nv.code === 0) {
    const vals = nv.stdout.split('\n').map(Number).filter(Number.isFinite);
    if (vals.length) vram = vals.reduce((a, b) => a + b, 0) / 1024;
  }
  return { ramFreeGB: Math.round(ramFree * 10) / 10, vramFreeGB: vram === undefined ? undefined : Math.round(vram * 10) / 10, cpuLoad: Math.round((loadavg()[0]! / Math.max(1, cpus().length)) * 100) / 100, at: now };
}

const machineMetrics = (service: string, s: MachineSample): UsageMetric[] => {
  const base = { service, source: 'observed' as const, observedAt: s.at, confidence: 'high' as const };
  const out: UsageMetric[] = [
    { ...base, metric: 'ram_free_gb', value: s.ramFreeGB, unit: 'gb', origin: process.platform === 'darwin' ? 'vm_stat' : 'os.freemem' },
    { ...base, metric: 'cpu_load', value: s.cpuLoad, unit: 'ratio', origin: 'os.loadavg', note: '1-minute load per core' },
  ];
  if (s.vramFreeGB !== undefined) out.push({ ...base, metric: 'vram_free_gb', value: s.vramFreeGB, unit: 'gb', origin: 'nvidia-smi' });
  return out;
};

type Runtime = 'ollama' | 'lms' | 'llamacpp';

function localProvider(id: Runtime, label: string, benchRuntime: string): UsageProvider {
  return {
    id,
    label,
    kind: 'local',
    async collect(ctx: UsageContext): Promise<ServiceUsage> {
      const base = { service: id, label, kind: 'local' as const };
      const d = ctx.det[id];
      if (!d.installed) return { ...base, status: 'unavailable', statusSource: 'observed', statusNote: `${label} not installed`, metrics: [] };
      const sample = await (ctx.sampleMachine ?? (() => sampleMachine(ctx.now)))();
      const metrics: UsageMetric[] = [...machineMetrics(id, sample)];
      const models = id === 'ollama' ? ctx.det.ollama.models.length : id === 'lms' ? ctx.det.lms.models.length : ctx.det.llamacpp.models.length;
      metrics.push({ service: id, metric: 'models_installed', value: models, unit: 'count', source: 'observed', origin: 'cb detect', observedAt: ctx.det.at || ctx.now, confidence: 'high' });

      // contexte maximal et vitesse : seulement ce qui a été mesuré
      const machine = ctx.det.hardware.chip;
      const bench = readBench().filter((b) => b.key.startsWith(`${machine}|${benchRuntime}|`) && b.tokensPerSecond);
      const best = bench.sort((a, b) => b.at - a.at)[0];
      metrics.push(
        best
          ? { service: id, metric: 'tokens_per_s', value: best.tokensPerSecond!, unit: 'tokens_per_s', source: 'observed', origin: `benchmark ${best.model}`, observedAt: best.at, confidence: 'high' }
          : { service: id, metric: 'tokens_per_s', value: null, unit: 'tokens_per_s', source: 'unknown', origin: 'none', observedAt: null, confidence: 'low', note: 'not benchmarked (codebreak models bench <model>)' },
      );
      if (id === 'ollama' && d.installed) {
        try {
          const res = await ctx.fetchImpl(`${ctx.cfg.ollama.base_url}/api/ps`, { signal: AbortSignal.timeout(1500) });
          const j = (await res.json()) as { models?: { name: string; size?: number; size_vram?: number; context_length?: number }[] };
          const loaded = j.models ?? [];
          metrics.push({ service: id, metric: 'models_loaded', value: loaded.map((m) => m.name).join(', ') || 'none', unit: 'text', source: 'observed', origin: 'ollama /api/ps', observedAt: ctx.now, confidence: 'high' });
          const ctxLen = loaded.find((m) => m.context_length)?.context_length;
          if (ctxLen) metrics.push({ service: id, metric: 'context_length', value: ctxLen, unit: 'tokens', source: 'observed', origin: 'ollama /api/ps', observedAt: ctx.now, confidence: 'high' });
        } catch {
          /* serveur arrêté : la détection le dit déjà */
        }
      }
      const status: ServiceStatus = d.ready ? 'available' : 'unavailable';
      return { ...base, status, statusSource: 'observed', statusNote: d.ready ? undefined : d.detail, metrics };
    },
  };
}

export const ollamaProvider = localProvider('ollama', 'Ollama', 'ollama');
export const lmsProvider = localProvider('lms', 'LM Studio', 'lms');
export const llamacppProvider = localProvider('llamacpp', 'llama.cpp', 'llamacpp');
export { benchKey };

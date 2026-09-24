import type { HardwareInfo } from '../detect/types.js';
import { memoryBudget } from './compatibility/memory.js';
import type { Config } from '../config/schema.js';
import type { CatalogModel, Recommendation, Runtime, Verdict } from './types.js';
import { num, t } from '../i18n/index.js';

export const RUNTIME_LABEL: Record<Runtime | 'app', string> = { ollama: 'Ollama', mlx: 'MLX', huggingface: 'Hugging Face', app: 'Application' };

export const VERDICT_ICON: Record<Verdict, string> = { recommended: '🟢', alternative: '🟡', slow: '🐢', excluded: '🔴' };
const VERDICT_LABEL: Record<Verdict, string> = { recommended: 'Recommandé', alternative: 'Alternative', slow: 'Lent', excluded: 'Exclu' };
export const verdictLabel = (v: Verdict) => t(VERDICT_LABEL[v]);

/** Go avec une décimale (virgule française), « ? » si inconnu. */
export const fmtGB = (n: number | undefined) => (n === undefined ? t('inconnu') : `${num(n, 1)} ${t('Go')}`);

export const fmtParams = (m: Pick<CatalogModel, 'paramsB' | 'activeParamsB'>) =>
  m.paramsB === undefined ? 'inconnu' : `${m.paramsB < 1 ? Math.round(m.paramsB * 1000) + 'M' : m.paramsB.toFixed(1).replace(/\.0$/, '') + 'B'}${m.activeParamsB ? t(' ({v}B actifs)', { v: m.activeParamsB }) : ''}`;

export function fmtPerf(rec: Pick<Recommendation, 'fit'>): string {
  const p = rec.fit.performance;
  return p?.value === undefined ? 'inconnu' : `~${Math.round(p.value)} ${p.unit}`;
}

export const fmtDate = (iso: string | undefined) => (iso ? iso.slice(0, 10) : 'inconnue');

/** Résumé d'une machine pour l'en-tête de Discovery et `cb models recommend`. */
export function describeMachine(hw: HardwareInfo, cfg: Config): { title: string; memory: string; backend: string; budget: string } {
  const { pool, budgetGB } = memoryBudget(hw, cfg);
  const gpu = hw.gpus[0];
  const backend = { metal: 'Metal', cuda: 'CUDA', rocm: 'ROCm', cpu: 'CPU' }[hw.backend];
  const title = hw.appleSilicon || !gpu ? hw.chip : `${gpu.name}${hw.gpus.length > 1 ? ` ×${hw.gpus.length}` : ''}`;
  const memory =
    pool === 'unified' ? t('{memoryGB} Go mémoire unifiée', { memoryGB: hw.memoryGB }) : pool === 'vram' ? t('{vram} Go VRAM · {ram} Go RAM', { vram: hw.vramGB, ram: hw.memoryGB }) : t('{ram} Go RAM', { ram: hw.memoryGB });
  return { title, memory, backend: hw.appleSilicon && hw.mlx.supported ? `${backend} · MLX` : backend, budget: t('~{v} Go utilisables par un modèle', { v: Math.round(budgetGB) }) };
}

/** Ligne compacte d'un modèle : « Qwen · 4B · Q4_K_M · 5,2 Go · ~21 tok/s · Ollama ». */
export function summarizeModel(rec: Recommendation): string {
  const m = rec.model;
  return [m.provider, m.paramsB === undefined ? undefined : fmtParams(m), m.quantization, fmtGB(rec.fit.memory.neededGB), fmtPerf(rec) === 'inconnu' ? undefined : fmtPerf(rec), RUNTIME_LABEL[m.runtime]]
    .filter(Boolean)
    .join(' · ');
}

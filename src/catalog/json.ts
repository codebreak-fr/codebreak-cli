import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import { describeMachine } from './present.js';
import { memoryBudget } from './compatibility/memory.js';
import type { CategoryResult, Recommendation } from './types.js';

const round = (n: number | undefined, d = 2) => (n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Recommandation → JSON stable (raisons et métriques comprises), pour `cb models recommend --json`. */
export function recommendationJson(r: Recommendation) {
  const m = r.model;
  const mem = r.fit.memory;
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    publisher: m.publisher,
    runtime: m.runtime,
    verdict: r.verdict,
    installed: r.installed,
    routable: r.routable,
    categories: m.categories,
    capabilities: m.capabilities,
    parameters_b: round(m.paramsB),
    active_parameters_b: round(m.activeParamsB),
    quantization: m.quantization ?? null,
    context_length: m.contextLength ?? null,
    release_date: m.releaseDate ?? null,
    last_updated: m.lastUpdated ?? null,
    memory: { needed_gb: round(mem.neededGB), weights_gb: round(mem.weightsGB), kv_cache_gb: round(mem.kvCacheGB), overhead_gb: round(mem.overheadGB), headroom_gb: round(mem.headroomGB), budget_gb: round(mem.budgetGB), pool: mem.pool, ratio: round(mem.ratio) },
    performance: r.fit.performance ? { value: r.fit.performance.value ?? null, unit: r.fit.performance.unit, estimated: true } : null,
    scores: { recency: round(r.scores.recency), quality: round(r.scores.quality), compatibility: round(r.scores.compatibility), performance: round(r.scores.performance), total: round(r.scores.total) },
    why: r.why,
    warnings: r.warnings,
    signals: r.signals,
    source: m.source,
    source_url: m.sourceUrl,
    install_command: m.installCommand,
  };
}

export const categoryJson = (r: CategoryResult) => ({
  category: r.category,
  recommended: r.recommended.map(recommendationJson),
  slow: r.slow ? recommendationJson(r.slow) : null,
  excluded_count: r.excludedCount,
  excluded_reasons: r.excludedReasons,
});

export function hardwareJson(det: Detection, cfg: Config) {
  const hw = det.hardware;
  return {
    ...describeMachine(hw, cfg),
    platform: hw.platform,
    arch: hw.arch,
    chip: hw.chip,
    memory_gb: hw.memoryGB,
    vram_gb: hw.vramGB,
    gpus: hw.gpus,
    backend: hw.backend,
    mlx: hw.mlx.supported,
    bandwidth_gbps: hw.bandwidthGBps ?? null,
    usable_memory_gb: round(memoryBudget(hw, cfg).budgetGB, 1),
    runtimes: { ollama: det.ollama.installed, lmstudio: det.lms.installed, llamacpp: det.llamacpp.installed, huggingface_cli: det.huggingface.installed },
  };
}

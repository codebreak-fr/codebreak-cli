import { ledgerPath } from '../config/paths.js';
import type { BackendId } from '../types.js';
import { appendLine, readLines } from '../util/store.js';

export interface LedgerEntry {
  ts: number;
  /** identifiant de la demande (regroupe les tentatives d'une escalade) */
  task: string;
  target: string;
  backend: BackendId;
  category: string;
  complexity: number;
  ok: boolean;
  escalatedFrom?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  routerMs?: number;
  verify?: 'pass' | 'fail' | 'skipped';
  prompt?: string;
}

export function record(entry: LedgerEntry): void {
  appendLine(ledgerPath(), JSON.stringify(entry));
}

export function readLedger(limit = 5000): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of readLines(ledgerPath(), limit)) {
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      /* ligne corrompue ignorée */
    }
  }
  return out;
}

export interface TargetStats {
  target: string;
  runs: number;
  ok: number;
  escalations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgMs: number;
}

export interface Summary {
  tasks: number;
  runs: number;
  byTarget: TargetStats[];
  successRate: number;
  escalationRate: number;
  /** équivalent API Sonnet des tokens traités par des cibles gratuites */
  savedUsdEstimate: number;
}

const SONNET_IN = 3 / 1e6;
const SONNET_OUT = 15 / 1e6;

export function summarize(entries: LedgerEntry[], sinceMs = 0): Summary {
  const list = entries.filter((e) => e.ts >= sinceMs);
  const map = new Map<string, TargetStats & { ms: number }>();
  let saved = 0;
  for (const e of list) {
    const s = map.get(e.target) ?? {
      target: e.target,
      runs: 0,
      ok: 0,
      escalations: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      avgMs: 0,
      ms: 0,
    };
    s.runs++;
    if (e.ok) s.ok++;
    if (e.escalatedFrom) s.escalations++;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.costUsd += e.costUsd;
    s.ms += e.durationMs;
    map.set(e.target, s);
    if (!e.target.startsWith('claude:') && e.ok) {
      saved += e.inputTokens * SONNET_IN + e.outputTokens * SONNET_OUT;
    }
  }
  const byTarget = [...map.values()]
    .map(({ ms, ...s }) => ({ ...s, avgMs: s.runs ? ms / s.runs : 0 }))
    .sort((a, b) => b.runs - a.runs);
  const runs = list.length;
  return {
    tasks: new Set(list.map((e) => e.task)).size,
    runs,
    byTarget,
    successRate: runs ? list.filter((e) => e.ok).length / runs : 0,
    escalationRate: runs ? list.filter((e) => e.escalatedFrom).length / runs : 0,
    savedUsdEstimate: saved,
  };
}

export interface BackendStats {
  backend: BackendId;
  runs: number;
  ok: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastUsedAt: number;
}

/** Comme `summarize`, mais agrégé par backend plutôt que par modèle précis — pour afficher l'usage de chaque IA. */
export function usageByBackend(entries: LedgerEntry[], sinceMs = 0): Map<BackendId, BackendStats> {
  const map = new Map<BackendId, BackendStats>();
  for (const e of entries) {
    if (e.ts < sinceMs) continue;
    const s = map.get(e.backend) ?? { backend: e.backend, runs: 0, ok: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastUsedAt: 0 };
    s.runs++;
    if (e.ok) s.ok++;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.costUsd += e.costUsd;
    s.lastUsedAt = Math.max(s.lastUsedAt, e.ts);
    map.set(e.backend, s);
  }
  return map;
}

/** Taux d'échec récent d'une cible sur une catégorie (apprentissage léger). */
export function recentFailureRate(
  entries: LedgerEntry[],
  target: string,
  category: string,
  window = 8,
): { rate: number; samples: number } {
  const rel = entries.filter((e) => e.target === target && e.category === category).slice(-window);
  const judged = rel.filter((e) => e.verify !== 'skipped');
  if (judged.length === 0) return { rate: 0, samples: 0 };
  return { rate: judged.filter((e) => !e.ok).length / judged.length, samples: judged.length };
}

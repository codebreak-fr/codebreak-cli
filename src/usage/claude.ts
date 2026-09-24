import { usageCachePath } from '../config/paths.js';
import type { Config } from '../config/schema.js';
import type { ClaudeUsage, QuotaState, QuotaWindow } from '../types.js';
import { exec } from '../util/exec.js';
import { readJson, writeJson } from '../util/store.js';

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

const win = (w?: { utilization?: number; resetsAt?: number }, now = Date.now()): QuotaWindow | undefined =>
  w && typeof w.utilization === 'number' ? { utilization: w.utilization, resetsAt: w.resetsAt, observedAt: now } : undefined;

/** Extrait l'utilisation du quota d'un événement `rate_limit_event` de `claude -p --output-format stream-json`. */
export function parseRateLimitEvent(ev: { rate_limit_info?: RateLimitInfo }, now = Date.now()): Partial<ClaudeUsage> | null {
  const info = ev.rate_limit_info;
  if (!info) return null;
  const out: Partial<ClaudeUsage> = { status: info.status, rateLimitType: info.rateLimitType };
  out.fiveHour = win(info.unifiedWindows?.five_hour, now);
  out.sevenDay = win(info.unifiedWindows?.seven_day, now);
  // événement ne portant qu'une seule fenêtre
  if (!out.fiveHour && info.rateLimitType === 'five_hour' && typeof info.utilization === 'number') {
    out.fiveHour = { utilization: info.utilization, resetsAt: info.resetsAt, observedAt: now };
  }
  if (!out.sevenDay && info.rateLimitType === 'seven_day' && typeof info.utilization === 'number') {
    out.sevenDay = { utilization: info.utilization, resetsAt: info.resetsAt, observedAt: now };
  }
  if (info.overageStatus !== undefined || info.isUsingOverage !== undefined) {
    out.overage = { status: info.overageStatus, using: info.isUsingOverage, reason: info.overageDisabledReason };
  }
  return out;
}

export function loadUsage(): ClaudeUsage | null {
  return readJson<ClaudeUsage | null>(usageCachePath(), null);
}

export function mergeUsage(prev: ClaudeUsage | null, patch: Partial<ClaudeUsage>, now = Date.now()): ClaudeUsage {
  return {
    fiveHour: patch.fiveHour ?? prev?.fiveHour,
    sevenDay: patch.sevenDay ?? prev?.sevenDay,
    status: patch.status ?? prev?.status,
    rateLimitType: patch.rateLimitType ?? prev?.rateLimitType,
    overage: patch.overage ?? prev?.overage,
    fetchedAt: now,
  };
}

export function saveUsage(patch: Partial<ClaudeUsage>): ClaudeUsage {
  const merged = mergeUsage(loadUsage(), patch);
  writeJson(usageCachePath(), merged);
  return merged;
}

/** Une fenêtre dont l'échéance est passée est remise à zéro. */
export function effectiveUtilization(w: QuotaWindow | undefined, nowMs = Date.now()): number | null {
  if (!w) return null;
  if (w.resetsAt && w.resetsAt * 1000 < nowMs) return 0;
  return w.utilization;
}

const REJECTED_TTL_MS = 30 * 60_000;

export function quotaState(usage: ClaudeUsage | null, cfg: Config, nowMs = Date.now()): QuotaState {
  if (!usage) return 'unknown';
  // un refus n'est valable que peu de temps : sinon on n'appellerait plus Claude pour constater la réinitialisation
  if (usage.status === 'rejected' && nowMs - usage.fetchedAt < REJECTED_TTL_MS) return 'stop';
  const values = [effectiveUtilization(usage.fiveHour, nowMs), effectiveUtilization(usage.sevenDay, nowMs)].filter(
    (v): v is number => v !== null,
  );
  if (values.length === 0) return 'unknown';
  const u = Math.max(...values);
  const q = cfg.quota.claude;
  if (u >= q.stop) return 'stop';
  if (u >= q.hard) return 'hard';
  if (u >= q.soft) return 'soft';
  return 'ok';
}

export const isFresh = (u: ClaudeUsage | null, ttlMin: number, now = Date.now()) =>
  !!u && now - u.fetchedAt < ttlMin * 60_000;

/**
 * Sonde minimale (~600 tokens Haiku, sans outils ni MCP) pour lire le quota réel.
 * Chaque vraie exécution de Claude met aussi le cache à jour.
 */
export async function probeClaude(claudePath: string): Promise<ClaudeUsage | null> {
  const r = await exec(
    claudePath,
    [
      '-p',
      '.',
      '--model',
      'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--system-prompt',
      'Reply with one word.',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
    ],
    { timeoutMs: 30_000 },
  );
  let usage: ClaudeUsage | null = null;
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const patch = parseRateLimitEvent(JSON.parse(line));
      if (patch) usage = saveUsage(patch);
    } catch {
      /* ligne partielle */
    }
  }
  return usage;
}

export async function getClaudeUsage(
  claudePath: string | undefined,
  cfg: Config,
  opts: { force?: boolean } = {},
): Promise<ClaudeUsage | null> {
  const cached = loadUsage();
  if (!opts.force && isFresh(cached, cfg.quota.claude.probe_ttl_min)) return cached;
  if (!claudePath) return cached;
  return (await probeClaude(claudePath)) ?? cached;
}

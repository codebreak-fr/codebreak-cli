import { homedir } from 'node:os';
import type { QuotaWindow } from '../types.js';
import { effectiveUtilization } from '../usage/claude.js';
import { color } from './theme.js';
import { num, t } from '../i18n/index.js';

export const pct = (u: number) => `${Math.round(u * 100)}%`;

export function bar(u: number, width = 5): string {
  const filled = Math.max(0, Math.min(width, Math.round(u * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function quotaColor(u: number | null, soft = 0.75, hard = 0.9): string {
  if (u === null) return color.dim;
  if (u >= hard) return color.err;
  if (u >= soft) return color.warn;
  return color.ok;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${num(s, 1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${num(n / 1000, 1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function fmtReset(resetsAtSec: number | undefined, nowMs = Date.now()): string {
  if (!resetsAtSec) return '';
  const min = Math.round((resetsAtSec * 1000 - nowMs) / 60_000);
  if (min <= 0) return t('réinitialisé');
  if (min < 60) return t('dans {min} min', { min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('dans {h} h {v}', { h, v: String(min % 60).padStart(2, '0') });
  return t('dans {v} j {v2} h', { v: Math.floor(h / 24), v2: h % 24 });
}

export const shortPath = (p: string) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p);

/** Raccourcit un chemin au milieu s'il dépasse `max` caractères. */
export function ellipsizePath(p: string, max: number): string {
  const s = shortPath(p);
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}

export const utilOf = (w: QuotaWindow | undefined) => effectiveUtilization(w);

export const LEVEL_NAMES = ['local', 'gratuit', 'milieu', 'Sonnet', 'Opus'] as const;

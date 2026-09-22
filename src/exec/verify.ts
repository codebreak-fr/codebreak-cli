import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { exec } from '../util/exec.js';
import { t } from '../i18n/index.js';

export interface VerifyStep {
  command: string;
  ok: boolean;
  output: string;
  ms: number;
}

export interface VerifyResult {
  ok: boolean;
  steps: VerifyStep[];
}

function runner(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm run -s';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn -s';
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun run';
  return 'npm run -s';
}

/** typecheck / lint / test détectés dans package.json (un script par famille). */
export function detectVerifyCommands(cwd: string, cfg: Config): string[] {
  if (cfg.verify.mode === 'off') return [];
  if (cfg.verify.commands.length) return cfg.verify.commands;
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    return [];
  }
  const run = runner(cwd);
  const families = [['typecheck', 'type-check', 'check-types', 'tsc'], ['lint'], ['test']];
  const out: string[] = [];
  for (const fam of families) {
    const name = fam.find((n) => scripts[n]);
    if (!name) continue;
    const body = scripts[name]!;
    if (/no test specified/.test(body) || /--watch\b|\bwatch\b/.test(body)) continue;
    out.push(`${run} ${name}`);
  }
  return out;
}

const tail = (s: string, n = 3000) => (s.length > n ? '…' + s.slice(-n) : s);

export async function runVerify(cwd: string, commands: string[], cfg: Config, signal?: AbortSignal): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  for (const command of commands) {
    const started = Date.now();
    const r = await exec('/bin/sh', ['-c', command], {
      cwd,
      timeoutMs: cfg.verify.timeout_s * 1000,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      signal,
    });
    const ok = r.code === 0 && !r.timedOut;
    steps.push({
      command,
      ok,
      output: tail((r.stdout + '\n' + r.stderr).trim() + (r.timedOut ? t('\n[délai dépassé]') : '')),
      ms: Date.now() - started,
    });
    if (!ok) break;
  }
  return { ok: steps.every((s) => s.ok), steps };
}

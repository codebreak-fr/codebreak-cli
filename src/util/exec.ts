import { spawn, type SpawnOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Exécute une commande et renvoie la sortie complète. Ne rejette jamais. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: opts.signal,
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(e), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

export interface StreamResult {
  code: number | null;
  stderr: string;
}

/** Lance un process et itère sur les lignes de stdout ; renvoie le code de sortie à la fin. */
export async function* streamLines(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; detached?: boolean } = {},
): AsyncGenerator<string, StreamResult> {
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
  };
  const child = spawn(cmd, args, spawnOpts);
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d));
  child.stdin?.on('error', () => {});
  child.stdin?.end(opts.input ?? '');

  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      stderr += String(e);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  return { code: await exited, stderr };
}

const EXTRA_BIN_DIRS = () => [
  join(homedir(), '.opencode', 'bin'),
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

/** Cherche un exécutable dans le PATH (+ emplacements usuels). */
export function which(bin: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_BIN_DIRS()].filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* suivant */
    }
  }
  return null;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

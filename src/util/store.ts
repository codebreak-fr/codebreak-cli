import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Écriture atomique (fichier temporaire + rename). Ne lève jamais : l'état est un confort. */
export function writeJson(path: string, data: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, path);
  } catch {
    /* ignoré */
  }
}

export function appendLine(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + '\n', 'utf8');
  } catch {
    /* ignoré */
  }
}

export function readLines(path: string, limit = 5000): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

import { spawn } from 'node:child_process';
import type { Config } from '../config/schema.js';
import { sleep } from '../util/exec.js';

async function isUp(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** Démarre `ollama serve` en arrière-plan si nécessaire (option ollama.autostart). */
export async function ensureOllamaRunning(cfg: Config, bin = 'ollama'): Promise<boolean> {
  if (await isUp(cfg.ollama.base_url)) return true;
  if (!cfg.ollama.autostart) return false;
  spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (await isUp(cfg.ollama.base_url)) return true;
  }
  return false;
}

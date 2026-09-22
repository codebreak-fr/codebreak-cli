import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../src/config/schema.js';
import type { Detection } from '../src/detect/types.js';
import { buildTargets } from '../src/router/targets.js';
import { analyzeByRules } from '../src/router/heuristics.js';
import type { Decision, Target, TaskFeatures } from '../src/types.js';

export const detection: Detection = {
  hardware: {
    platform: 'darwin', arch: 'arm64', chip: 'Apple M4', cores: { total: 10 }, memoryGB: 16, freeMemoryGB: 6,
    appleSilicon: true, mlx: { supported: true, pythonMlx: true, pythonMlxLm: true }, gpus: [], backend: 'metal', vramGB: 0, bandwidthGBps: 120, onBattery: false,
    lowPowerMode: false, localBudgetGB: 8, tier: 'medium', recommendation: '',
  },
  claude: { installed: true, ready: true, detail: '', path: '/bin/claude' },
  opencode: { installed: true, ready: true, detail: '', path: '/bin/opencode', freeModels: ['opencode/big-pickle'], allModels: [] },
  ollama: {
    installed: true, ready: true, running: true, baseUrl: 'http://localhost:11434', detail: '',
    models: [{ name: 'ministral-3:8b', sizeGB: 5.6, paramsB: 8.9, capabilities: ['completion', 'tools'], fits: true, loaded: false }],
  },
  copilot: { installed: true, ready: true, chatSupported: true, extensionInstalled: false, detail: '', path: '/bin/code' },
  vibe: { installed: true, ready: true, detail: '', path: '/bin/vibe', version: '2.25.1' },
  gemini: { installed: true, ready: true, detail: '', path: '/bin/gemini', version: '0.59.0' },
  aider: { installed: true, ready: true, detail: '', path: '/bin/aider', version: '0.86.2' },
  lms: { installed: true, ready: false, running: false, baseUrl: 'http://localhost:1234', detail: '', models: [] },
  llamacpp: { installed: true, ready: false, runningServer: false, baseUrl: 'http://localhost:8080', detail: '', models: [] },
  huggingface: { installed: false, ready: false, detail: '' },
  inventory: { apps: [], models: [], packages: [] },
  others: [], at: 0,
};

export const defaultCfg = () => ConfigSchema.parse({});

export function targetsOf(cfg = defaultCfg()): Record<string, Target> {
  return Object.fromEntries(buildTargets(detection, cfg).map((t) => [t.id, t]));
}

export function decisionOf(chain: Target[], over: Partial<TaskFeatures> = {}): Decision {
  return {
    features: { ...analyzeByRules('ajoute un test'), needsEdit: true, needsRepo: true, ...over },
    requiredLevel: 0,
    primary: chain[0] ?? null,
    chain,
    reasons: [],
    warnings: [],
    quota: 'ok',
    degraded: false,
    forced: false,
    privacyLocked: false,
  };
}

/** Dépôt git temporaire avec un script `test` contrôlable. */
export function tempRepo(testScript = 'node check.js'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cr-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', scripts: { test: testScript } }));
  writeFileSync(join(dir, 'check.js'), "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)");
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

export function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cr-home-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

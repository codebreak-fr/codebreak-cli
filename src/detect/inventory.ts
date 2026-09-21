import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { guessCategory } from '../catalog/categories.js';
import { dirSizeGB, hfCacheDir } from '../catalog/installed.js';
import { exec, which } from '../util/exec.js';
import type { AiApp, AiInventory, LocalAiModel2 } from './types.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

interface AppSpec {
  name: string;
  kinds: string[];
  /** bundles macOS (relatifs à /Applications et ~/Applications) */
  bundles?: string[];
  bins?: string[];
  /** dossiers utilisateur (relatifs à $HOME) dont la présence signale l'outil */
  dirs?: string[];
}

/** Outils d'IA locale connus : des applications, jamais des modèles. */
const APPS: AppSpec[] = [
  { name: 'MacWhisper', kinds: ['stt'], bundles: ['MacWhisper.app'] },
  { name: 'SuperWhisper', kinds: ['stt'], bundles: ['superwhisper.app', 'SuperWhisper.app'] },
  { name: 'Handy', kinds: ['stt'], bundles: ['Handy.app'] },
  { name: 'Ollama', kinds: ['llm'], bundles: ['Ollama.app'] },
  { name: 'LM Studio', kinds: ['llm'], bundles: ['LM Studio.app'], dirs: ['.lmstudio'] },
  { name: 'Jan', kinds: ['llm'], bundles: ['Jan.app'] },
  { name: 'Msty', kinds: ['llm'], bundles: ['Msty.app'] },
  { name: 'GPT4All', kinds: ['llm'], bundles: ['gpt4all.app', 'GPT4All.app'] },
  { name: 'Enchanted', kinds: ['llm'], bundles: ['Enchanted.app'] },
  { name: 'Draw Things', kinds: ['image'], bundles: ['Draw Things.app'] },
  { name: 'DiffusionBee', kinds: ['image'], bundles: ['DiffusionBee.app'] },
  { name: 'ComfyUI', kinds: ['image', 'video'], bundles: ['ComfyUI.app'], bins: ['comfy'] },
  { name: 'oMLX', kinds: ['llm'], bins: ['omlx'], dirs: ['.omlx'] },
  { name: 'Osaurus', kinds: ['llm', 'assistant'], bundles: ['Osaurus.app'], bins: ['osaurus'], dirs: ['.osaurus'] },
  { name: 'whisper.cpp', kinds: ['stt'], bins: ['whisper-cli', 'whisper-server', 'whisper-cpp'] },
  { name: 'llama.cpp', kinds: ['llm'], bins: ['llama-cli', 'llama-server'] },
  { name: 'Pocket TTS', kinds: ['tts'], bins: ['pocket-tts'] },
  { name: 'parakeet-mlx', kinds: ['stt'], bins: ['parakeet-mlx'] },
  { name: 'mlx-whisper', kinds: ['stt'], bins: ['mlx_whisper'] },
  { name: 'mlx-audio', kinds: ['tts', 'stt'], bins: ['mlx_audio.tts.generate', 'mlx_audio.stt.generate'] },
  { name: 'Piper', kinds: ['tts'], bins: ['piper'] },
  { name: 'Kokoro', kinds: ['tts'], bins: ['kokoro', 'kokoro-tts'] },
  { name: 'faster-whisper', kinds: ['stt'], bins: ['faster-whisper', 'whisper-ctranslate2'] },
  { name: 'Whisper (OpenAI)', kinds: ['stt'], bins: ['whisper'] },
];

/** Dossiers de données d'apps (Application Support) dont le nom trahit un outil d'IA non listé ci-dessus. */
const AI_HINT = /(whisper|parakeet|tts|speech|voice|diffusion|comfy|llm|lm-studio|ollama|pocket|kokoro)/i;

const PY_PACKAGES = [
  'mlx', 'mlx-lm', 'mlx-audio', 'mlx-whisper', 'mlx-vlm', 'parakeet-mlx', 'pocket-tts', 'kokoro', 'qwen-tts', 'f5-tts',
  'torch', 'transformers', 'diffusers', 'sentence-transformers', 'faster-whisper', 'openai-whisper', 'nemo-toolkit',
  'vllm', 'llama-cpp-python', 'piper-tts', 'onnxruntime', 'mflux', 'huggingface-hub',
];

// ---- dossiers de modèles ----

const WEIGHTS = /\.(mlmodelc|mlpackage|mlmodel|safetensors|gguf|bin|onnx)$/i;

/** Dossiers « feuilles » contenant des poids (un modèle = le plus haut dossier qui en contient directement). */
export function findModelDirs(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => WEIGHTS.test(e.name))) return void out.push(dir);
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  // variantes de précision / de version (W8A16, 384_94MB, v2-1…) : le modèle est leur dossier parent
  const variant = /^(w\d+a\d+|\d+_\d+mb|v\d+(?:[-.]\d+)*|fp\d+|int\d+|\d+bit)$/i;
  const lift = (dir: string): string => {
    let d = dir;
    while (d !== root && variant.test(basename(d))) d = dirname(d);
    return d;
  };
  return [...new Set(out.map(lift))];
}

/** Modèles du cache Hugging Face (`models--org--name`). */
export function scanHfCache(root = hfCacheDir()): LocalAiModel2[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('models--'))
    .map((e) => {
      const name = e.name.slice('models--'.length).replace(/--/g, '/');
      const path = join(root, e.name);
      return { name, store: 'Hugging Face', runtime: name.startsWith('mlx-community/') ? ('mlx' as const) : ('huggingface' as const), category: guessCategory(name), sizeGB: round1(dirSizeGB(path)), path };
    });
}

function scanStore(root: string, store: string, depth: number): LocalAiModel2[] {
  if (!existsSync(root)) return [];
  return findModelDirs(root, depth).map((path) => {
    const name = path.slice(root.length + 1).split('/').slice(-2).join('/');
    return { name, store, runtime: 'app' as const, category: guessCategory(name), sizeGB: round1(dirSizeGB(path)), path };
  });
}

/** Racines où la suppression d'un modèle détecté est autorisée (garde-fou de `runRemove`). */
export function modelRoots(home = homedir()): string[] {
  return [
    hfCacheDir(),
    join(home, 'Library', 'Application Support', 'MacWhisper', 'models'),
    join(home, '.lmstudio', 'models'),
    join(home, '.cache', 'lm-studio', 'models'),
    join(home, '.omlx', 'models'),
  ];
}

export interface InventoryOptions {
  home?: string;
  hfRoot?: string;
  /** désactive les appels système (tests) */
  skipPython?: boolean;
}

export async function detectInventory(opts: InventoryOptions = {}): Promise<AiInventory> {
  const home = opts.home ?? homedir();
  const apps: AiApp[] = [];
  const seen = new Set<string>();
  for (const spec of APPS) {
    const bundle = spec.bundles?.map((b) => [join('/Applications', b), join(home, 'Applications', b)]).flat().find(existsSync);
    const bin = spec.bins?.map((b) => which(b)).find(Boolean) ?? undefined;
    const dir = spec.dirs?.map((d) => join(home, d)).find(existsSync);
    const path = bundle ?? bin ?? dir;
    if (path) {
      apps.push({ name: spec.name, kinds: spec.kinds, path });
      seen.add(spec.name.toLowerCase().replace(/[^a-z]/g, ''));
    }
  }
  // outils inconnus repérés à leur dossier de données (ex. des scripts Parakeet maison)
  const support = join(home, 'Library', 'Application Support');
  if (existsSync(support)) {
    for (const e of readdirSync(support, { withFileTypes: true })) {
      const key = e.name.toLowerCase().replace(/[^a-z]/g, '');
      if (!e.isDirectory() || !AI_HINT.test(e.name) || e.name.startsWith('com.') || [...seen].some((s) => key.includes(s) || s.includes(key))) continue;
      apps.push({ name: e.name, kinds: ['other'], path: join(support, e.name) });
    }
  }

  const models = [
    ...scanHfCache(opts.hfRoot),
    ...scanStore(join(home, 'Library', 'Application Support', 'MacWhisper', 'models'), 'MacWhisper', 6),
    ...scanStore(join(home, '.lmstudio', 'models'), 'LM Studio', 3),
    ...scanStore(join(home, '.omlx', 'models'), 'oMLX', 3),
  ];

  const packages = opts.skipPython ? [] : await pythonPackages();
  return { apps, models, packages };
}

async function pythonPackages(): Promise<string[]> {
  const script = [
    'import importlib.metadata as m, json',
    `names = ${JSON.stringify(PY_PACKAGES)}`,
    'found = []',
    'for n in names:',
    '    try:',
    '        found.append(n + " " + m.version(n))',
    '    except Exception:',
    '        pass',
    'print(json.dumps(found))',
  ].join('\n');
  const r = await exec('python3', ['-c', script], { timeoutMs: 4000 });
  try {
    return r.code === 0 ? (JSON.parse(r.stdout) as string[]) : [];
  } catch {
    return [];
  }
}

export type GpuBackend = 'metal' | 'cuda' | 'rocm' | 'cpu';

export interface GpuInfo {
  name: string;
  vendor: 'apple' | 'nvidia' | 'amd' | 'other';
  /** VRAM dédiée (Go) ; absente pour un GPU à mémoire unifiée */
  vramGB?: number;
  /** bande passante mémoire (Go/s) quand le modèle est reconnu */
  bandwidthGBps?: number;
}

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  chip: string;
  cores: { total: number; performance?: number; efficiency?: number };
  gpuCores?: number;
  memoryGB: number;
  freeMemoryGB: number;
  appleSilicon: boolean;
  /** MLX exploitable : Apple Silicon (macOS arm64) */
  mlx: { supported: boolean; pythonMlx: boolean; pythonMlxLm: boolean };
  /** GPU dédiés détectés (vide sur Apple Silicon : mémoire unifiée, et sur CPU seul) */
  gpus: GpuInfo[];
  /** backend d'inférence le plus performant disponible */
  backend: GpuBackend;
  /** VRAM totale des GPU dédiés (Go), 0 si aucun */
  vramGB: number;
  /** bande passante mémoire de la machine (Go/s) si connue, sinon absente (jamais inventée) */
  bandwidthGBps?: number;
  onBattery: boolean;
  lowPowerMode: boolean;
  /** taille max (Go) d'un modèle local pour rester confortable */
  localBudgetGB: number;
  tier: 'small' | 'medium' | 'large' | 'xl';
  recommendation: string;
}

export interface OllamaModel {
  name: string;
  sizeGB: number;
  /** milliards de paramètres */
  paramsB?: number;
  quantization?: string;
  capabilities: string[];
  contextLength?: number;
  fits: boolean;
  loaded: boolean;
}

export interface ToolInfo {
  installed: boolean;
  path?: string;
  version?: string;
  /** prêt à être utilisé (authentifié, démarré…) */
  ready: boolean;
  detail: string;
}

export interface ClaudeInfo extends ToolInfo {
  authMethod?: string;
  email?: string;
}

export interface OpencodeInfo extends ToolInfo {
  /** modèles gratuits hébergés par OpenCode (provider "opencode") */
  freeModels: string[];
  /** tous les modèles connus */
  allModels: string[];
}

export interface OllamaInfo extends ToolInfo {
  running: boolean;
  baseUrl: string;
  models: OllamaModel[];
}

export interface CopilotInfo extends ToolInfo {
  chatSupported: boolean;
  extensionInstalled: boolean;
  /** CLI Copilot autonome détecté (non utilisé pour le routage) */
  standaloneCli?: string;
}

export interface VibeInfo extends ToolInfo {}

export interface GeminiInfo extends ToolInfo {}

export interface AiderInfo extends ToolInfo {}

/** Modèle proposé par un backend local (LM Studio, llama.cpp). */
export interface LocalModel {
  /** identifiant passé au serveur (ou nom affiché pour llama-cli) */
  id: string;
  label?: string;
  /** chemin du fichier de poids, quand connu (llama.cpp) */
  path?: string;
  sizeGB?: number;
  loaded?: boolean;
  fits: boolean;
}

export interface LmsInfo extends ToolInfo {
  running: boolean;
  baseUrl: string;
  models: LocalModel[];
}

export interface LlamacppInfo extends ToolInfo {
  runningServer: boolean;
  baseUrl: string;
  cliPath?: string;
  serverPath?: string;
  models: LocalModel[];
}

export interface OtherCli {
  name: string;
  path: string;
}

/** Hugging Face CLI (`hf` / `huggingface-cli`) : sert à télécharger les modèles MLX et Transformers. */
export interface HuggingfaceInfo extends ToolInfo {}

/** Application ou outil d'IA locale trouvé sur la machine (MacWhisper, LM Studio, whisper.cpp…). */
export interface AiApp {
  name: string;
  /** usages : llm, stt, tts, image, assistant… */
  kinds: string[];
  path: string;
}

/** Modèle présent sur disque hors Ollama (cache Hugging Face, MacWhisper, LM Studio, oMLX). */
export interface LocalAiModel2 {
  name: string;
  /** dépôt/dossier de stockage lisible : « Hugging Face », « MacWhisper »… */
  store: string;
  runtime: 'mlx' | 'huggingface' | 'app';
  category?: import('../catalog/types.js').CategoryId;
  sizeGB: number;
  path: string;
}

export interface AiInventory {
  apps: AiApp[];
  models: LocalAiModel2[];
  /** paquets Python d'IA installés (mlx-audio, torch, transformers…) */
  packages: string[];
}

export interface Detection {
  hardware: HardwareInfo;
  claude: ClaudeInfo;
  opencode: OpencodeInfo;
  ollama: OllamaInfo;
  copilot: CopilotInfo;
  vibe: VibeInfo;
  gemini: GeminiInfo;
  aider: AiderInfo;
  lms: LmsInfo;
  llamacpp: LlamacppInfo;
  huggingface: HuggingfaceInfo;
  inventory: AiInventory;
  others: OtherCli[];
  at: number;
}

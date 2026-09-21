export type Runtime = 'ollama' | 'mlx' | 'huggingface';

export type CategoryId =
  | 'coding'
  | 'general'
  | 'reasoning'
  | 'vision'
  | 'rag'
  | 'embeddings'
  | 'reranking'
  | 'stt'
  | 'tts'
  | 'image'
  | 'video'
  | 'ocr'
  | 'agents';

export type Capability = 'tools' | 'vision' | 'thinking' | 'embedding' | 'code';

export type QuantSource = 'name' | 'tag' | 'dtype' | 'default' | 'unknown';

/** Entrée de catalogue : un modèle pour UN runtime. Tout champ inconnu reste `undefined` (jamais inventé). */
export interface CatalogModel {
  id: string;
  name: string;
  /** fournisseur d'origine (Qwen, Mistral, Google…) — sert à la règle « un seul modèle par fournisseur » */
  provider: string;
  /** compte qui publie le fichier (ex. mlx-community) */
  publisher: string;
  categories: CategoryId[];
  capabilities: Capability[];
  paramsB?: number;
  /** paramètres actifs (MoE), quand le nom l'indique (ex. 30b-a3b) */
  activeParamsB?: number;
  quantization?: string;
  format: 'gguf' | 'safetensors' | 'mlx' | 'other';
  runtime: Runtime;
  contextLength?: number;
  /** poids sur disque / en mémoire (Go) ; `undefined` = inconnu */
  sizeGB?: number;
  sizeSource?: 'registry' | 'params';
  releaseDate?: string;
  lastUpdated?: string;
  languages?: string[];
  /** signaux de popularité de la source */
  downloads?: number;
  likes?: number;
  source: 'ollama' | 'huggingface' | 'mlx';
  sourceUrl: string;
  fetchedAt: number;
  /** commande d'installation affichée à l'utilisateur */
  installCommand: string;
}

export type Verdict = 'recommended' | 'alternative' | 'slow' | 'excluded';

export type ExcludeReason =
  | 'too-heavy'
  | 'too-slow'
  | 'unknown-size'
  | 'runtime-missing'
  | 'stale'
  | 'low-signal'
  | 'wrong-hardware';

export interface MemoryBreakdown {
  weightsGB: number;
  kvCacheGB: number;
  overheadGB: number;
  neededGB: number;
  headroomGB: number;
  budgetGB: number;
  /** de quelle mémoire on parle : VRAM du GPU, mémoire unifiée ou RAM */
  pool: 'vram' | 'unified' | 'ram';
  /** neededGB / budgetGB */
  ratio: number;
}

export interface Performance {
  /** valeur estimée (tokens/s pour un LLM, passes/s pour embeddings/reranking) ; absente = inconnue */
  value?: number;
  unit: 'tok/s' | 'passes/s';
  estimated: true;
}

export interface Fit {
  verdict: Verdict;
  memory: MemoryBreakdown;
  performance?: Performance;
  reason?: ExcludeReason;
}

export interface Scores {
  recency: number;
  quality: number;
  compatibility: number;
  performance: number;
  total: number;
}

export interface Recommendation {
  model: CatalogModel;
  verdict: Exclude<Verdict, 'excluded'>;
  fit: Fit;
  scores: Scores;
  installed: boolean;
  /** exécutable par le routeur CodeBreak (runtime piloté par cb) */
  routable: boolean;
  why: string[];
  warnings: string[];
  signals: string[];
}

export interface CategoryResult {
  category: CategoryId;
  recommended: Recommendation[];
  slow: Recommendation | null;
  excludedCount: number;
  excludedReasons: Partial<Record<ExcludeReason, number>>;
}

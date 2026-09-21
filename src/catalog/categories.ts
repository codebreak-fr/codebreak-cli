import { t } from '../i18n/index.js';
import type { CategoryId, Capability } from './types.js';

/** Famille de métriques : détermine l'estimation mémoire/perf et la présentation. */
export type MetricKind = 'llm' | 'embedding' | 'audio' | 'diffusion';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  /** une phrase : à quoi sert cette catégorie */
  description: string;
  icon: string;
  kind: MetricKind;
  /** balises HF `pipeline_tag` interrogées pour cette catégorie */
  pipelines: string[];
  /** mémoire hors poids : marge d'activations en fraction des poids + surcoût fixe (Go) */
  activationFactor: number;
  fixedOverheadGB: number;
}

const llm = { kind: 'llm' as const, activationFactor: 0.05, fixedOverheadGB: 0.6 };

/** Ajouter une catégorie = une entrée ici (+ éventuellement une règle dans `classify`). */
export const CATEGORIES: CategoryDef[] = [
  { id: 'coding', label: 'Code', description: 'Écrire, corriger et expliquer du code ; modèles entraînés pour la programmation.', icon: '💻', pipelines: ['text-generation', 'image-text-to-text'], ...llm },
  { id: 'general', label: 'Général / Chat', description: 'Assistants polyvalents : questions, rédaction, résumé, traduction.', icon: '🧠', pipelines: ['text-generation', 'image-text-to-text'], ...llm },
  { id: 'reasoning', label: 'Raisonnement', description: 'Modèles qui « réfléchissent » avant de répondre : maths, logique, problèmes complexes.', icon: '🧩', pipelines: ['text-generation', 'image-text-to-text'], ...llm },
  { id: 'vision', label: 'Vision', description: 'Comprennent les images : décrire une capture, lire un schéma, répondre sur une photo.', icon: '👁', pipelines: ['image-text-to-text'], ...llm, fixedOverheadGB: 1.2 },
  { id: 'rag', label: 'RAG (contexte long)', description: 'Longs contextes pour interroger de gros documents ou une base de connaissances.', icon: '📚', pipelines: ['text-generation'], ...llm },
  { id: 'embeddings', label: 'Embeddings', description: 'Transforment du texte en vecteurs pour la recherche sémantique et le RAG.', icon: '🔢', pipelines: ['feature-extraction', 'sentence-similarity'], kind: 'embedding', activationFactor: 0.15, fixedOverheadGB: 0.3 },
  { id: 'reranking', label: 'Reranking', description: 'Reclassent les résultats d\'une recherche pour mettre les plus pertinents en tête.', icon: '🎯', pipelines: ['text-ranking'], kind: 'embedding', activationFactor: 0.15, fixedOverheadGB: 0.3 },
  { id: 'stt', label: 'Voix → texte (STT)', description: 'Transcription : convertit la voix ou une réunion en texte (Whisper, Parakeet…).', icon: '🎙', pipelines: ['automatic-speech-recognition'], kind: 'audio', activationFactor: 0.3, fixedOverheadGB: 0.5 },
  { id: 'tts', label: 'Texte → voix (TTS)', description: 'Synthèse vocale : lit un texte à voix haute, parfois en clonant une voix.', icon: '🔊', pipelines: ['text-to-speech'], kind: 'audio', activationFactor: 0.3, fixedOverheadGB: 0.5 },
  { id: 'image', label: 'Génération d’image', description: 'Génère des images à partir d\'un texte (Stable Diffusion, FLUX…).', icon: '🎨', pipelines: ['text-to-image'], kind: 'diffusion', activationFactor: 0.4, fixedOverheadGB: 2 },
  { id: 'video', label: 'Génération de vidéo', description: 'Génère de courtes vidéos à partir d\'un texte ou d\'une image ; très gourmand.', icon: '🎬', pipelines: ['text-to-video', 'image-to-video'], kind: 'diffusion', activationFactor: 0.6, fixedOverheadGB: 4 },
  { id: 'ocr', label: 'OCR / Documents', description: 'Extrait le texte de scans, PDF et documents (factures, formulaires).', icon: '📄', pipelines: ['image-to-text', 'image-text-to-text', 'document-question-answering'], ...llm, fixedOverheadGB: 1.2 },
  { id: 'agents', label: 'Agents / Outils', description: 'Modèles fiables avec les outils (function calling) pour automatiser des tâches.', icon: '🤖', pipelines: ['text-generation'], ...llm },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<CategoryId, CategoryDef>;

/** Libellé / description dans la langue courante (les champs de `CATEGORIES` sont les clés françaises). */
export const categoryLabel = (id: CategoryId) => t(CATEGORY_BY_ID[id].label);
export const categoryDescription = (id: CategoryId) => t(CATEGORY_BY_ID[id].description);

export const isCategoryId = (s: string): s is CategoryId => s in CATEGORY_BY_ID;

export interface ClassifyInput {
  name: string;
  pipeline?: string;
  tags?: string[];
  capabilities?: Capability[];
  contextLength?: number;
}

const CODE_RE = /(coder|codestral|devstral|codegemma|starcoder|codellama|code-|-code|\bcode\b|swe-|coding)/i;
const REASON_RE = /(reason|think|\br1\b|-r1|qwq|magistral|deepthink|distill|\bo1\b|cot)/i;
const OCR_RE = /(ocr|document|docling|donut|nougat|pdf|layout|paddleocr|got-ocr|olmocr)/i;
const AGENT_RE = /(agent|tool-use|tool_use|function-calling|function_calling|tool-calling)/i;
const RAG_RE = /(\brag\b|retrieval|long-context)/i;

const PIPELINE_TO_CATEGORY: Record<string, CategoryId> = {
  'automatic-speech-recognition': 'stt',
  'text-to-speech': 'tts',
  'text-to-audio': 'tts',
  'text-to-image': 'image',
  'text-to-video': 'video',
  'image-to-video': 'video',
  'feature-extraction': 'embeddings',
  'sentence-similarity': 'embeddings',
  'text-ranking': 'reranking',
  'document-question-answering': 'ocr',
};

/** Détermine les catégories d'un modèle d'après ses métadonnées (jamais d'après une liste de modèles). */
export function classify(input: ClassifyInput): CategoryId[] {
  const { name, pipeline, tags = [], capabilities = [], contextLength } = input;
  const hay = `${name} ${tags.join(' ')}`;
  const out = new Set<CategoryId>();

  if (capabilities.includes('embedding')) out.add(/rerank/i.test(hay) ? 'reranking' : 'embeddings');
  else if (pipeline && PIPELINE_TO_CATEGORY[pipeline]) out.add(PIPELINE_TO_CATEGORY[pipeline]!);
  else if (/rerank/i.test(hay)) out.add('reranking');
  if (out.size) {
    if (OCR_RE.test(name) && !out.has('ocr') && pipeline === 'image-to-text') out.add('ocr');
    return [...out];
  }

  // pipeline image-to-text : OCR / documents
  if (pipeline === 'image-to-text') return ['ocr'];

  // LLM (génération de texte, éventuellement multimodal)
  const vision = capabilities.includes('vision') || pipeline === 'image-text-to-text' || /(\bvl\b|-vl-|vision|multimodal)/i.test(name);
  if (OCR_RE.test(name)) out.add('ocr');
  if (vision) out.add('vision');
  if (CODE_RE.test(hay) || capabilities.includes('code')) out.add('coding');
  if (capabilities.includes('thinking') || REASON_RE.test(hay)) out.add('reasoning');
  if (capabilities.includes('tools') || AGENT_RE.test(hay)) out.add('agents');
  if (RAG_RE.test(hay) || (contextLength && contextLength >= 65536 && !out.has('coding'))) out.add('rag');
  // généraliste : un LLM qui n'est pas spécialisé code / OCR
  if (!out.has('coding') && !out.has('ocr')) out.add('general');
  return [...out];
}

/** Catégorie probable d'un modèle déjà installé, d'après son seul nom (pas de métadonnées de registre). */
export function guessCategory(name: string): CategoryId | undefined {
  const n = name.toLowerCase();
  if (/(tokenizer|codec|s3tokenizer|sortformer|pyannote|speaker|vad)/.test(n)) return undefined; // composants, pas un modèle utilisable seul
  if (/(parakeet|whisper|canary|wav2vec|\basr\b|stt|speech-to-text|moonshine)/.test(n)) return 'stt';
  if (/(tts|kokoro|piper|vibevoice|voice|pocket|luxtts|f5-|orpheus|dia-|bark|speecht5|audio-gen)/.test(n)) return 'tts';
  if (/rerank/.test(n)) return 'reranking';
  if (/(embed|bge-|gte-|e5-|minilm|nomic)/.test(n)) return 'embeddings';
  if (/(flux|stable-diffusion|sdxl|qwen-image|kolors|sana|z-image|diffusion)/.test(n)) return 'image';
  if (/(wan2|ltx|hunyuanvideo|cogvideo|mochi|video)/.test(n)) return 'video';
  if (/ocr/.test(n)) return 'ocr';
  if (/(coder|code)/.test(n)) return 'coding';
  if (/(-vl|vision|llava|pixtral|paligemma)/.test(n)) return 'vision';
  return 'general';
}

/** Normalise un nom de fournisseur en clé de comparaison (« Qwen » = « qwen » = « QwenLM »). */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Organisation Hugging Face → fournisseur d'origine. Uniquement des noms d'éditeurs, jamais des modèles. */
const ORG_ALIASES: Record<string, string> = {
  qwen: 'Qwen', qwenlm: 'Qwen', alibabanlp: 'Qwen',
  metallama: 'Meta', facebook: 'Meta', meta: 'Meta',
  mistralai: 'Mistral', mistral: 'Mistral',
  deepseekai: 'DeepSeek', deepseek: 'DeepSeek',
  google: 'Google', googledeepmind: 'Google',
  microsoft: 'Microsoft', openai: 'OpenAI', nvidia: 'NVIDIA',
  ibmgranite: 'IBM', ibm: 'IBM', zaiorg: 'Zhipu', thudm: 'Zhipu', zai: 'Zhipu',
  moonshotai: 'Moonshot', minimaxai: 'MiniMax', xiaomimimo: 'Xiaomi', allenai: 'Ai2',
  huggingfacetb: 'Hugging Face', huggingface: 'Hugging Face',
  blackforestlabs: 'Black Forest Labs', stabilityai: 'Stability AI', lightricks: 'Lightricks',
  liquidai: 'Liquid AI', cohereforai: 'Cohere', coherelabs: 'Cohere', baai: 'BAAI', jinaai: 'Jina', nomicai: 'Nomic', snowflake: 'Snowflake', tencent: 'Tencent',
};

/** Préfixe de nom de famille → fournisseur (Ollama n'expose pas l'éditeur). */
const FAMILY_PREFIXES: [RegExp, string][] = [
  [/^(qwen|qwq)/i, 'Qwen'],
  [/^(llama|codellama)/i, 'Meta'],
  [/^(mistral|ministral|mixtral|codestral|devstral|magistral|pixtral|voxtral)/i, 'Mistral'],
  [/^(gemma|codegemma|embeddinggemma|paligemma)/i, 'Google'],
  [/^deepseek/i, 'DeepSeek'],
  [/^(phi|orca)/i, 'Microsoft'],
  [/^granite/i, 'IBM'],
  [/^(glm|chatglm|cogview|cogvideo)/i, 'Zhipu'],
  [/^gpt-oss/i, 'OpenAI'],
  [/^(nemotron|nv-)/i, 'NVIDIA'],
  [/^olmo/i, 'Ai2'],
  [/^smol/i, 'Hugging Face'],
  [/^(kimi|moonshot)/i, 'Moonshot'],
  [/^minimax/i, 'MiniMax'],
  [/^mimo/i, 'Xiaomi'],
  [/^(whisper|gpt-)/i, 'OpenAI'],
  [/^(flux)/i, 'Black Forest Labs'],
  [/^(bge)/i, 'BAAI'],
  [/^(nomic)/i, 'Nomic'],
  [/^lfm/i, 'Liquid AI'],
  [/^(cohere|command|aya)/i, 'Cohere'],
  [/^(hunyuan)/i, 'Tencent'],
  [/^(yi-|yi:)/i, '01.AI'],
  [/^(solar)/i, 'Upstage'],
  [/^(exaone)/i, 'LG AI'],
];

const QUANTIZERS = new Set(
  ['mlxcommunity', 'unsloth', 'bartowski', 'lmstudiocommunity', 'thebloke', 'ggml', 'ggufmodels', 'mradermacher', 'second-state', 'secondstate', 'ollama'].map(key),
);

export const isQuantizer = (publisher: string) => QUANTIZERS.has(key(publisher));

const titleCase = (s: string) => s.replace(/(^|[-_ ])([a-z])/g, (_, a: string, b: string) => `${a === '-' || a === '_' ? ' ' : a}${b.toUpperCase()}`).trim();

export function providerFromOrg(org: string): string {
  return ORG_ALIASES[key(org)] ?? org;
}

export function providerFromFamily(name: string): string {
  const family = name.split('/').pop()!.split(':')[0]!;
  const hit = FAMILY_PREFIXES.find(([re]) => re.test(family));
  if (hit) return hit[1];
  return titleCase(family.split(/[-_.:]/)[0] ?? family);
}

/**
 * Fournisseur d'un dépôt Hugging Face : l'organisation d'origine (tag `base_model:org/name`)
 * plutôt que le republieur (mlx-community, unsloth…) ; à défaut, le préfixe de famille du nom.
 */
export function providerFromHf(repoId: string, tags: string[] = []): string {
  const [author = '', ...rest] = repoId.split('/');
  const name = rest.join('/') || author;
  if (!isQuantizer(author)) return providerFromOrg(author);
  const base = tags.find((t) => t.startsWith('base_model:') && !t.startsWith('base_model:quantized:') && !t.startsWith('base_model:finetune:'));
  const baseOrg = base?.slice('base_model:'.length).split('/')[0];
  if (baseOrg && !isQuantizer(baseOrg)) return providerFromOrg(baseOrg);
  const finetuned = tags.find((t) => /^base_model:(quantized|finetune):/.test(t))?.replace(/^base_model:(quantized|finetune):/, '').split('/')[0];
  if (finetuned && !isQuantizer(finetuned)) return providerFromOrg(finetuned);
  return providerFromFamily(name);
}

export const providerKey = key;

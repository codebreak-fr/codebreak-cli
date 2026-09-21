export interface Quant {
  label?: string;
  bits?: number;
}

/** Déduit la quantification d'un nom/tag (`4bit`, `q4_K_M`, `bf16`, `awq`…). */
export function parseQuant(...hay: (string | undefined)[]): Quant {
  const s = hay.filter(Boolean).join(' ').toLowerCase();
  let m = /\bq(\d)_(?:k_[sml]|k|[01])\b|[-_:.]q(\d)_(?:k_[sml]|k|[01])\b/.exec(s);
  if (m) return { label: /q\d_[a-z0-9_]+/.exec(s)![0].toUpperCase(), bits: Number(m[1] ?? m[2]) };
  m = /(?:^|[^a-z0-9])(\d{1,2})[-_ ]?bit/.exec(s) ?? /\bint(\d)\b/.exec(s);
  if (m) return { label: `${m[1]}-bit`, bits: Number(m[1]) };
  if (/\b(awq|gptq)\b/.test(s)) return { label: /awq/.test(s) ? 'AWQ' : 'GPTQ', bits: 4 };
  if (/\bmxfp4\b|\bnvfp4\b|\bfp4\b/.test(s)) return { label: 'FP4', bits: 4 };
  if (/\b(fp8|f8)\b/.test(s)) return { label: 'FP8', bits: 8 };
  if (/\b(bf16|fp16|f16)\b/.test(s)) return { label: /bf16/.test(s) ? 'BF16' : 'FP16', bits: 16 };
  if (/\b(fp32|f32)\b/.test(s)) return { label: 'FP32', bits: 32 };
  return {};
}

/** Octets par paramètre d'un poids quantifié sur `bits` bits (échelles/zéros compris). */
export const bytesPerParam = (bits: number) => (bits >= 16 ? bits / 8 : (bits / 8) * 1.08);

const DTYPE_BYTES: Record<string, number> = {
  F64: 8, I64: 8, U64: 8, F32: 4, BF16: 2, F16: 2, F8_E4M3: 1, F8_E5M2: 1, F8: 1, I8: 1, U8: 1, BOOL: 1, I16: 2, U16: 2,
};

/**
 * Taille des poids (Go) d'après le décompte `safetensors.parameters` de Hugging Face.
 * Les dtypes entiers 32 bits (I32/U32) désignent des poids quantifiés empaquetés : HF les compte déjà
 * en paramètres logiques, on applique donc les octets/paramètre de la quantification (4 bits par défaut).
 */
export function sizeFromDtypes(params: Record<string, number>, bits?: number): number {
  let bytes = 0;
  for (const [dtype, n] of Object.entries(params)) {
    const per = /^[IU]32$/.test(dtype) ? bytesPerParam(bits && bits < 16 ? bits : 4) : (DTYPE_BYTES[dtype] ?? 2);
    bytes += n * per;
  }
  return bytes / 1024 ** 3;
}

/** `30b-a3b` → { paramsB: 30, activeParamsB: 3 } ; `270m` → 0.27 ; sans indice → {}. */
export function parseParams(name: string): { paramsB?: number; activeParamsB?: number } {
  const s = name.toLowerCase();
  const total = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s?([bm])(?![a-z0-9])/.exec(s);
  const active = /[-_:.]a(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(s);
  const toB = (v: string, unit: string) => (unit === 'm' ? Number(v) / 1000 : Number(v));
  return {
    paramsB: total ? toB(total[1]!, total[2]!) : undefined,
    activeParamsB: active ? Number(active[1]) : undefined,
  };
}

export interface Sibling {
  rfilename: string;
  size?: number;
}

/**
 * Taille des poids (Go) d'un dépôt d'après la liste de ses fichiers (`?blobs=true`). Ignore les doublons qui ne seraient
 * pas chargés ensemble : dans un dépôt diffusers (`model_index.json`), les checkpoints monolithiques à la racine ;
 * quand une variante `.fp16.` existe, sa version pleine précision.
 */
export function sizeFromSiblings(siblings: Sibling[]): number | undefined {
  const names = new Set(siblings.map((s) => s.rfilename));
  const diffusers = names.has('model_index.json');
  let bytes = 0;
  for (const { rfilename: f, size } of siblings) {
    if (!f.endsWith('.safetensors') || !size) continue;
    if (diffusers && !f.includes('/')) continue;
    if (names.has(f.replace(/\.safetensors$/, '.fp16.safetensors')) || names.has(f.replace(/(-\d+-of-\d+)?\.safetensors$/, '.fp16$1.safetensors'))) continue;
    bytes += size;
  }
  return bytes ? bytes / 1024 ** 3 : undefined;
}

import { CATEGORIES, classify } from '../categories.js';
import { parseParams, parseQuant, sizeFromDtypes, sizeFromSiblings, type Sibling } from '../quant.js';
import { isQuantizer, providerFromHf } from '../providers.js';
import type { Capability, CatalogModel, Runtime } from '../types.js';
import { fetchJson, mapLimit, monthsBetween, type CatalogSource, type SourceContext } from './http.js';
import { t } from '../../i18n/index.js';

export interface HfRaw {
  id: string;
  downloads?: number;
  likes?: number;
  createdAt?: string;
  lastModified?: string;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  gated?: boolean | string;
  safetensors?: { parameters?: Record<string, number>; total?: number };
  siblings?: Sibling[];
}

/** Fine-tunes, merges, adaptateurs et dépôts de test : pas des modèles « de référence ». */
const DERIVED_TAG = /^base_model:(finetune|merge|adapter):/;
const JUNK_NAME = /(?:^|[-_/.])(tiny|random|dummy|test|nsfw|uncensored|abliterated|adapter|merge|dpo)(?:$|[-_/.])|lora/i;

export function isReferenceModel(raw: HfRaw): boolean {
  const tags = raw.tags ?? [];
  if (tags.some((t) => DERIVED_TAG.test(t)) || JUNK_NAME.test(raw.id.split('/')[1] ?? raw.id)) return false;
  // une quantification n'est fiable que si elle vient d'un republieur connu (mlx-community, unsloth…)
  if (tags.some((t) => t.startsWith('base_model:quantized:')) && !isQuantizer(raw.id.split('/')[0] ?? '')) return false;
  return true;
}

const EXPAND = ['safetensors', 'createdAt', 'lastModified', 'downloads', 'likes', 'tags', 'pipeline_tag', 'library_name', 'gated']
  .map((f) => `expand[]=${f}`)
  .join('&');

const LANG_RE = /^(?:[a-z]{2}|multilingual)$/;

/** Convertit une fiche de l'API Hugging Face en entrée de catalogue (`null` = inutilisable). */
export function parseHfModel(raw: HfRaw, source: 'huggingface' | 'mlx', now: number): CatalogModel | null {
  const tags = raw.tags ?? [];
  if (raw.gated) return null; // téléchargement impossible sans connexion
  if (source === 'huggingface' && tags.some((t) => t === 'gguf' || t === 'mlx')) return null;
  if (!isReferenceModel(raw)) return null;
  const [publisher = '', ...rest] = raw.id.split('/');
  const name = rest.join('/') || raw.id;

  const capabilities: Capability[] = [];
  if (tags.some((t) => /tool-use|tool_use|function-calling|function_calling/.test(t))) capabilities.push('tools');
  if (raw.pipeline_tag === 'image-text-to-text') capabilities.push('vision');
  if (tags.some((t) => /reasoning|thinking/.test(t))) capabilities.push('thinking');

  const categories = classify({ name, pipeline: raw.pipeline_tag, tags, capabilities });
  if (!categories.length) return null;

  const quant = parseQuant(name, tags.join(' '));
  const st = raw.safetensors;
  const nameParams = parseParams(name);
  const paramsB = st?.total ? st.total / 1e9 : nameParams.paramsB;
  let sizeGB: number | undefined;
  let sizeSource: CatalogModel['sizeSource'];
  if (raw.siblings) {
    sizeGB = sizeFromSiblings(raw.siblings);
    sizeSource = 'params';
  }
  if (sizeGB === undefined && st?.parameters && Object.keys(st.parameters).length) {
    sizeGB = sizeFromDtypes(st.parameters, quant.bits);
    sizeSource = 'params';
  }
  const runtime: Runtime = source === 'mlx' ? 'mlx' : 'huggingface';
  return {
    id: `${runtime}:${raw.id}`,
    name: raw.id,
    provider: providerFromHf(raw.id, tags),
    publisher,
    categories,
    capabilities,
    paramsB: paramsB ? Math.round(paramsB * 100) / 100 : undefined,
    activeParamsB: nameParams.activeParamsB,
    quantization: quant.label,
    format: source === 'mlx' ? 'mlx' : 'safetensors',
    runtime,
    sizeGB: sizeGB ? Math.round(sizeGB * 100) / 100 : undefined,
    sizeSource,
    releaseDate: raw.createdAt,
    lastUpdated: raw.lastModified,
    languages: tags.filter((t) => LANG_RE.test(t)).slice(0, 8),
    downloads: raw.downloads,
    likes: raw.likes,
    source,
    sourceUrl: `https://huggingface.co/${raw.id}`,
    fetchedAt: now,
    installCommand: `hf download ${raw.id}`,
  };
}

const PIPELINES = [...new Set(CATEGORIES.flatMap((c) => c.pipelines))];

/** Requêtes : par pipeline, les plus tendance et les plus téléchargés. */
export function hfQueryUrls(source: 'huggingface' | 'mlx'): string[] {
  const base = 'https://huggingface.co/api/models';
  const scope = source === 'mlx' ? 'filter=mlx&author=mlx-community&' : '';
  return PIPELINES.flatMap((p) => ['trendingScore', 'downloads'].map((sort) => `${base}?${scope}pipeline_tag=${p}&sort=${sort}&limit=60&${EXPAND}`));
}

export function makeHfSource(source: 'huggingface' | 'mlx'): CatalogSource {
  return {
    id: source,
    async fetch(ctx: SourceContext): Promise<CatalogModel[]> {
      if (source === 'mlx' && !ctx.appleSilicon) return [];
      const urls = hfQueryUrls(source);
      let done = 0;
      let firstError = '';
      const pages = await mapLimit(urls, 6, async (url) => {
        try {
          return await fetchJson<HfRaw[]>(ctx, url);
        } catch (e) {
          firstError ||= (e as Error).message;
          return [] as HfRaw[];
        } finally {
          ctx.onProgress?.(`${source} ${++done}/${urls.length}`);
        }
      });
      if (pages.every((p) => p.length === 0)) throw new Error(`${source} : ${firstError || t('aucune réponse')}`);
      const seen = new Map<string, CatalogModel>();
      for (const raw of pages.flat()) {
        if (seen.has(raw.id)) continue;
        const age = monthsBetween(raw.createdAt ?? raw.lastModified, ctx.now);
        if (age !== undefined && age > ctx.maxAgeMonths * 1.5) continue; // évite de garder le bruit ancien en cache
        const m = parseHfModel(raw, source, ctx.now);
        if (m) seen.set(raw.id, m);
      }
      // dépôts sans décompte safetensors (diffusers…) : la taille vient de la liste des fichiers
      const unsized = [...seen.values()]
        .filter((m) => m.sizeGB === undefined && (m.downloads ?? 0) >= ctx.minDownloads * 4)
        .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
        .slice(0, 60);
      await mapLimit(unsized, 6, async (m) => {
        try {
          const raw = await fetchJson<HfRaw>(ctx, `https://huggingface.co/api/models/${m.name}?blobs=true`);
          const fixed = parseHfModel({ ...raw, id: m.name, gated: raw.gated }, source, ctx.now);
          if (fixed) seen.set(m.name, fixed);
        } catch {
          /* taille inconnue : le modèle sera écarté */
        }
      });
      return [...seen.values()];
    },
  };
}

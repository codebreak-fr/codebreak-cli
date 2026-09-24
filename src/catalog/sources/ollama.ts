import { classify } from '../categories.js';
import { parseParams, parseQuant } from '../quant.js';
import { providerFromFamily } from '../providers.js';
import type { Capability, CatalogModel } from '../types.js';
import { fetchText, mapLimit, monthsBetween, type CatalogSource, type SourceContext } from './http.js';

export interface OllamaLibraryEntry {
  name: string;
  description: string;
  badges: string[];
  pulls?: number;
  updatedIso?: string;
}

export interface OllamaTagRow {
  tag: string;
  digest?: string;
  sizeGB?: number;
  contextLength?: number;
  inputs: string[];
}

const strip = (s: string) => s.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export function parseCount(s: string | undefined): number | undefined {
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec((s ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ''));
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
  return Math.round(n * mult);
}

/** Page `https://ollama.com/library` → entrées (nom, badges, pulls, date de mise à jour). */
export function parseOllamaLibrary(html: string): OllamaLibraryEntry[] {
  const out: OllamaLibraryEntry[] = [];
  for (const chunk of html.split(/<li\s+class="flex items-baseline/).slice(1)) {
    const name = /href="\/library\/([^"\s]+)"/.exec(chunk)?.[1];
    if (!name) continue;
    const description = strip(/<p class="max-w-lg[^>]*>([\s\S]*?)<\/p>/.exec(chunk)?.[1] ?? '');
    const badges = [...chunk.matchAll(/<span\s+class="inline-flex[^>]*>\s*([^<]+?)\s*<\/span>/g)].map((m) => m[1]!.toLowerCase());
    const pulls = parseCount(/<span\s*>\s*([\d.,]+[KMB]?)\s*<\/span>\s*<span[^>]*>&nbsp;Pulls/.exec(chunk)?.[1]);
    const title = /title="([A-Za-z]{3} \d{1,2}, \d{4}[^"]*)"/.exec(chunk)?.[1];
    const t = title ? Date.parse(title.replace(/ UTC$/, ' GMT')) : NaN;
    out.push({ name, description, badges, pulls, updatedIso: Number.isNaN(t) ? undefined : new Date(t).toISOString() });
  }
  return out;
}

/** Page `https://ollama.com/library/<nom>/tags` → une ligne par tag (taille, contexte, entrées). */
export function parseOllamaTags(html: string): OllamaTagRow[] {
  const rows: OllamaTagRow[] = [];
  for (const chunk of html.split(/<div class="group px-4 py-3">/).slice(1)) {
    const tag = /href="\/library\/([^"\s]+)"/.exec(chunk)?.[1];
    if (!tag) continue;
    const text = strip(chunk);
    const size = /([\d.]+)\s?(GB|MB)\b/.exec(text);
    const ctx = /(\d+)\s?([KM]) context window/.exec(text);
    const inputs = [...(/((?:Text|Image|Audio|Video)(?:, (?:Text|Image|Audio|Video))*) input/.exec(text)?.[1]?.toLowerCase().split(', ') ?? [])];
    rows.push({
      tag,
      digest: /\b([0-9a-f]{12})\b/.exec(text)?.[1],
      sizeGB: size ? (size[2] === 'MB' ? Number(size[1]) / 1024 : Number(size[1])) : undefined,
      contextLength: ctx ? Number(ctx[1]) * (ctx[2] === 'M' ? 1024 * 1024 : 1024) : undefined,
      inputs,
    });
  }
  return rows;
}

/** Convertit un tag Ollama en entrée de catalogue. `null` = à ignorer (cloud, doublon `latest`…). */
export function ollamaModelFromTag(entry: OllamaLibraryEntry, row: OllamaTagRow, now: number, allRows: OllamaTagRow[]): CatalogModel | null {
  const fullName = row.tag; // « qwen3:8b »
  const variant = fullName.split(':')[1] ?? 'latest';
  if (/cloud/.test(variant) || !row.sizeGB) return null;
  if (/(^|[-_])i?q[12](_|$)/i.test(variant)) return null; // quantifications 1-2 bits : qualité dégradée
  if (variant === 'latest' && row.digest && allRows.some((r) => r !== row && r.digest === row.digest)) return null;

  const capabilities: Capability[] = [];
  if (entry.badges.includes('tools')) capabilities.push('tools');
  if (entry.badges.includes('vision') || row.inputs.includes('image')) capabilities.push('vision');
  if (entry.badges.includes('thinking')) capabilities.push('thinking');
  if (entry.badges.includes('embedding')) capabilities.push('embedding');

  const params = parseParams(variant);
  const quant = parseQuant(variant);
  return {
    id: `ollama:${fullName}`,
    name: fullName,
    provider: providerFromFamily(entry.name),
    publisher: 'ollama',
    categories: classify({ name: entry.name, capabilities, contextLength: row.contextLength }),
    capabilities,
    paramsB: params.paramsB,
    activeParamsB: params.activeParamsB,
    quantization: quant.label,
    format: 'gguf',
    runtime: 'ollama',
    contextLength: row.contextLength,
    sizeGB: Math.round(row.sizeGB * 100) / 100,
    sizeSource: 'registry',
    lastUpdated: entry.updatedIso,
    downloads: entry.pulls,
    source: 'ollama',
    sourceUrl: `https://ollama.com/library/${fullName}`,
    fetchedAt: now,
    installCommand: `ollama pull ${fullName}`,
  };
}

export const ollamaSource: CatalogSource = {
  id: 'ollama',
  async fetch(ctx: SourceContext): Promise<CatalogModel[]> {
    const [newest, popular] = await Promise.all([
      fetchText(ctx, 'https://ollama.com/library?sort=newest'),
      fetchText(ctx, 'https://ollama.com/library'),
    ]);
    const byName = new Map<string, OllamaLibraryEntry>();
    for (const e of [...parseOllamaLibrary(newest), ...parseOllamaLibrary(popular)]) if (!byName.has(e.name)) byName.set(e.name, e);

    // candidats : modernes (mise à jour récente), locaux (pas seulement cloud), avec une traction minimale
    const candidates = [...byName.values()]
      .filter((e) => !(e.badges.includes('cloud') && !e.badges.some((b) => /^\d+(\.\d+)?[bm]$/.test(b))))
      .filter((e) => (monthsBetween(e.updatedIso, ctx.now) ?? Infinity) <= ctx.maxAgeMonths)
      .filter((e) => (e.pulls ?? 0) >= ctx.minDownloads)
      .sort((a, b) => (b.pulls ?? 0) - (a.pulls ?? 0))
      .slice(0, ctx.ollamaTagPages);

    let done = 0;
    const lists = await mapLimit(candidates, 6, async (entry) => {
      try {
        const rows = parseOllamaTags(await fetchText(ctx, `https://ollama.com/library/${entry.name}/tags`));
        return rows.map((r) => ollamaModelFromTag(entry, r, ctx.now, rows)).filter((m): m is CatalogModel => m !== null);
      } catch {
        return [];
      } finally {
        ctx.onProgress?.(`ollama ${++done}/${candidates.length}`);
      }
    });
    return lists.flat();
  },
};

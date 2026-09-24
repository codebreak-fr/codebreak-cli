import type { Config } from '../config/schema.js';
import type { HardwareInfo } from '../detect/types.js';
import { modelRegistryPath } from '../config/paths.js';
import { readJson, writeJson } from '../util/store.js';
import { isFresh, readCache, writeCache } from './cache.js';
import { makeHfSource } from './sources/huggingface.js';
import type { CatalogSource, FetchLike, SourceContext } from './sources/http.js';
import { mlxSource } from './sources/mlx.js';
import { ollamaSource } from './sources/ollama.js';
import type { CatalogModel, CategoryId, Verdict } from './types.js';

export const SOURCES: CatalogSource[] = [ollamaSource, makeHfSource('huggingface'), mlxSource];

export interface Catalog {
  models: CatalogModel[];
  /** date du plus ancien élément du cache utilisé */
  fetchedAt: number;
  /** au moins une source a échoué : on a servi des données en cache plus anciennes que le TTL, ou rien */
  errors: { source: string; message: string }[];
  stale: boolean;
}

export interface LoadOptions {
  refresh?: boolean;
  now?: number;
  fetchImpl?: FetchLike;
  cachePath?: string;
  sources?: CatalogSource[];
  onProgress?: (message: string) => void;
}

/** Catalogue courant : cache si frais, sinon réseau ; repli sur le cache périmé quand le réseau échoue. */
export async function loadCatalog(cfg: Config, hw: Pick<HardwareInfo, 'appleSilicon'>, opts: LoadOptions = {}): Promise<Catalog> {
  const now = opts.now ?? Date.now();
  const d = cfg.discovery;
  const ctx: SourceContext = {
    now,
    fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
    appleSilicon: hw.appleSilicon,
    maxAgeMonths: d.max_age_months,
    minDownloads: d.min_downloads,
    ollamaTagPages: d.ollama_tag_pages,
    onProgress: opts.onProgress,
  };
  const cache = readCache(opts.cachePath);
  const errors: Catalog['errors'] = [];
  let stale = false;
  let dirty = false;

  const active = (opts.sources ?? SOURCES).filter((s) => s.id !== 'mlx' || hw.appleSilicon);
  const results = await Promise.all(
    active.map(async (source) => {
      const cached = cache.sources[source.id];
      if (!opts.refresh && isFresh(cached, d.cache_ttl_hours, now)) return cached;
      try {
        const models = await source.fetch(ctx);
        const entry = { fetchedAt: now, models };
        cache.sources[source.id] = entry;
        dirty = true;
        return entry;
      } catch (e) {
        errors.push({ source: source.id, message: (e as Error).message });
        if (cached) stale = true;
        return cached;
      }
    }),
  );
  if (dirty) writeCache(cache, opts.cachePath);
  const present = results.filter((r): r is NonNullable<typeof r> => Boolean(r));
  return {
    models: present.flatMap((r) => r.models),
    fetchedAt: present.length ? Math.min(...present.map((r) => r.fetchedAt)) : 0,
    errors,
    stale,
  };
}

// --- registre des modèles installés (lu plus tard par le routeur) ---

export interface RegistryEntry {
  id: string;
  name: string;
  runtime: CatalogModel['runtime'];
  provider: string;
  categories: CategoryId[];
  hardwareFit: Verdict;
  tokensPerSecond?: number;
  installedAt: number;
}

export const readRegistry = (path = modelRegistryPath()): RegistryEntry[] => readJson<RegistryEntry[]>(path, []);

export function recordInstalled(entry: RegistryEntry, path = modelRegistryPath()): void {
  writeJson(path, [...readRegistry(path).filter((e) => e.id !== entry.id), entry]);
}

export function forgetInstalled(id: string, path = modelRegistryPath()): void {
  writeJson(path, readRegistry(path).filter((e) => e.id !== id));
}

import { catalogCachePath } from '../config/paths.js';
import { readJson, writeJson } from '../util/store.js';
import type { CatalogModel } from './types.js';

const VERSION = 1;

export interface SourceCache {
  fetchedAt: number;
  models: CatalogModel[];
}

export interface CatalogCache {
  version: number;
  sources: Record<string, SourceCache>;
}

export const emptyCache = (): CatalogCache => ({ version: VERSION, sources: {} });

export function readCache(path = catalogCachePath()): CatalogCache {
  const c = readJson<CatalogCache>(path, emptyCache());
  return c.version === VERSION && c.sources ? c : emptyCache();
}

export const writeCache = (cache: CatalogCache, path = catalogCachePath()) => writeJson(path, cache);

export const isFresh = (entry: SourceCache | undefined, ttlHours: number, now: number): entry is SourceCache =>
  !!entry && now - entry.fetchedAt < ttlHours * 3_600_000;

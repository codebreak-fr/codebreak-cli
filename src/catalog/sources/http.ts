export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SourceContext {
  now: number;
  fetchImpl: FetchLike;
  appleSilicon: boolean;
  maxAgeMonths: number;
  minDownloads: number;
  ollamaTagPages: number;
  onProgress?: (message: string) => void;
}

export interface CatalogSource {
  id: 'ollama' | 'huggingface' | 'mlx';
  fetch(ctx: SourceContext): Promise<import('../types.js').CatalogModel[]>;
}

const UA = { 'user-agent': 'codebreak-cli (model discovery)' };

export async function fetchText(ctx: SourceContext, url: string, timeoutMs = 15000): Promise<string> {
  const res = await ctx.fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

export async function fetchJson<T>(ctx: SourceContext, url: string, timeoutMs = 20000): Promise<T> {
  return JSON.parse(await fetchText(ctx, url, timeoutMs)) as T;
}

/** Exécute `fn` sur chaque élément avec au plus `limit` requêtes simultanées. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export const monthsBetween = (fromIso: string | undefined, now: number): number | undefined => {
  if (!fromIso) return undefined;
  const t = Date.parse(fromIso);
  return Number.isNaN(t) ? undefined : (now - t) / (30.44 * 864e5);
};

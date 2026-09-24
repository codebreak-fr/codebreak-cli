/** Lecture/écriture de Markdown structuré en entrées « ## titre » avec métadonnées `clé: valeur` optionnelles. */

export interface MdEntry {
  heading: string;
  body: string;
  /** métadonnées lues dans les premières lignes (`tags:`, `files:`, `task:`, `kind:`…) */
  meta: Record<string, string>;
  /** date ISO trouvée dans le titre (YYYY-MM-DD) */
  date?: string;
  pinned: boolean;
}

const META_LINE = /^\s*[-*]?\s*(tags|files|task|kind|command|pinned|agent|summary)\s*:\s*(.+?)\s*$/i;
const PLACEHOLDER_ONLY = /^\s*(?:_[^_\n]+_\s*|<!--[\s\S]*?-->\s*)*$/;

/** true si le corps ne contient que le texte d'exemple du modèle (aucune information réelle). */
export const isPlaceholder = (body: string) => PLACEHOLDER_ONLY.test(body.trim());

/** Découpe un fichier Markdown en entrées `## …` (le préambule avant la première entrée est ignoré). */
export function parseEntries(md: string): MdEntry[] {
  const out: MdEntry[] = [];
  const parts = md.split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : part.slice(nl + 1)).replace(/\s+$/, '');
    const meta: Record<string, string> = {};
    for (const line of body.split('\n').slice(0, 12)) {
      const m = META_LINE.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!;
    }
    out.push({
      heading,
      body,
      meta,
      date: /\d{4}-\d{2}-\d{2}/.exec(heading)?.[0] ?? /\d{4}-\d{2}-\d{2}/.exec(meta.task ?? '')?.[0],
      pinned: /^(true|yes|1)$/i.test(meta.pinned ?? '') || /<!--\s*pin\s*-->/i.test(body),
    });
  }
  return out;
}

/** Fragment Markdown d'une entrée (pour l'écriture). */
export function renderEntry(heading: string, lines: string[], code?: string): string {
  const body = lines.filter((l) => l !== undefined && l !== '').map((l) => `- ${l}`).join('\n');
  return `\n## ${heading}\n${body}\n${code ? `\n\`\`\`text\n${code.replace(/```/g, "'''")}\n\`\`\`\n` : ''}`;
}

export const splitList = (s: string | undefined): string[] =>
  (s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

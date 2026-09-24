import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config/schema.js';
import { memoryPaths, type MemoryPaths } from './layout.js';
import { clip, isPlaceholder, parseEntries, splitList, type MdEntry } from './md.js';
import { listManifests } from './manifest.js';
import { redact } from '../util/redact.js';

/**
 * Sélection du contexte envoyé à un agent : jamais tout `.codebreak/`, seulement ce qui se rapporte à la tâche
 * (mots-clés, fichiers cités, récence), dans un budget de caractères, avec la raison de chaque inclusion ou exclusion.
 */

export type ContextKind = 'goal' | 'constraints' | 'commands' | 'state' | 'verification' | 'decision' | 'failure' | 'architecture' | 'files';

export type ReasonCode =
  | 'always' // contexte permanent (objectif, contraintes, commandes)
  | 'pinned'
  | 'relevant'
  | 'file_match'
  | 'similar_failure'
  | 'latest'
  | 'below_threshold'
  | 'over_budget'
  | 'placeholder'
  | 'cap';

export interface ContextItem {
  kind: ContextKind;
  source: string;
  heading: string;
  included: boolean;
  score: number;
  chars: number;
  reason: { code: ReasonCode; terms?: string[]; files?: string[] };
}

export interface ContextPack {
  /** texte à préfixer au prompt (vide si rien de pertinent) */
  text: string;
  items: ContextItem[];
  budget: number;
  usedChars: number;
  files: string[];
  counts: { files: number; decisions: number; failures: number; chars: number };
}

export interface BuildOptions {
  /** fichiers déjà connus comme concernés (ex. ceux d'une tâche précédente) */
  files?: string[];
  now?: number;
  /** score minimal pour inclure une entrée non toujours-incluse */
  threshold?: number;
}

const STOP = new Set(
  'the and for with that this from into your you are was were will would should could can not but all any use using make add fix get set new old code file files project task les des une pour avec dans sur par pas que qui est sont aux ces cette ainsi fait faire ajoute ajouter corrige corriger utilise utiliser'.split(' '),
);

/** Mots significatifs d'un texte (minuscules, sans mots vides, pluriel simple retiré). */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return [...out];
}

const PATH_RE = /[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,6}|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|kt|swift|rb|php|css|scss|html|json|ya?ml|toml|md|sql|sh)\b/g;

export const pathsIn = (text: string): string[] => [...new Set(text.match(PATH_RE) ?? [])];

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const CAP_ENTRY = 900;

interface Scored {
  entry: MdEntry;
  source: string;
  score: number;
  matched: string[];
  fileHits: string[];
}

function score(entry: MdEntry, taskTerms: string[], taskPaths: string[], idf: Map<string, number>, now: number): Scored {
  const head = new Set(terms(entry.heading));
  const meta = new Set(terms(`${entry.meta.tags ?? ''} ${entry.meta.files ?? ''} ${entry.meta.task ?? ''} ${entry.meta.kind ?? ''}`));
  const body = new Set(terms(entry.body));
  let s = 0;
  const matched: string[] = [];
  for (const t of taskTerms) {
    const w = idf.get(t) ?? 1;
    const hit = head.has(t) ? 3 : meta.has(t) ? 3 : body.has(t) ? 1 : 0;
    if (hit) {
      s += hit * w;
      matched.push(t);
    }
  }
  const files = splitList(entry.meta.files);
  const fileHits = taskPaths.filter((p) => {
    const base = p.split('/').pop()!;
    return files.some((f) => f === p || f.endsWith(`/${base}`)) || entry.body.includes(p);
  });
  s += fileHits.length * 4;
  if (entry.date && matched.length + fileHits.length > 0) {
    const ageDays = Math.max(0, (now - Date.parse(entry.date)) / 864e5);
    s += 0.5 * Math.pow(0.5, ageDays / 30);
  }
  return { entry, source: '', score: Math.round(s * 100) / 100, matched, fileHits };
}

function idfOf(all: MdEntry[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const e of all) for (const t of new Set(terms(`${e.heading} ${e.body}`))) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, all.length);
  return new Map([...df].map(([t, d]) => [t, Math.log(1 + n / d)]));
}

export function buildContext(cwd: string, cfg: Pick<Config, 'memory'>, prompt: string, opts: BuildOptions = {}): ContextPack {
  const empty: ContextPack = { text: '', items: [], budget: cfg.memory.max_context_chars, usedChars: 0, files: [], counts: { files: 0, decisions: 0, failures: 0, chars: 0 } };
  if (!cfg.memory.enabled) return empty;
  const p: MemoryPaths = memoryPaths(cwd, cfg);
  if (!existsSync(p.dir)) return empty;

  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? 1.5;
  const taskTerms = terms(prompt);
  const taskPaths = [...new Set([...pathsIn(prompt), ...(opts.files ?? [])])];
  const items: ContextItem[] = [];
  const blocks: { key: number; title: string; body: string; item: ContextItem }[] = [];
  let priority = 0;

  const add = (kind: ContextKind, source: string, e: { heading: string; body: string }, sc: Scored | null, reason: ContextItem['reason'], title: string) => {
    const body = clip(redact(e.body.trim()), CAP_ENTRY);
    const item: ContextItem = { kind, source, heading: e.heading, included: true, score: sc?.score ?? 0, chars: body.length, reason };
    items.push(item);
    blocks.push({ key: priority++, title, body, item });
  };
  const exclude = (kind: ContextKind, source: string, e: MdEntry, sc: Scored | null, code: ReasonCode) =>
    items.push({ kind, source, heading: e.heading, included: false, score: sc?.score ?? 0, chars: e.body.length, reason: { code, terms: sc?.matched, files: sc?.fileHits } });

  // 1. contexte permanent : objectif, contraintes, commandes (toujours, sauf texte d'exemple)
  const ctxEntries = parseEntries(read(p.context));
  for (const e of ctxEntries) {
    const name = e.heading.toLowerCase();
    const kind: ContextKind | null = name.startsWith('goal') ? 'goal' : name.startsWith('constraint') ? 'constraints' : name.startsWith('command') ? 'commands' : null;
    if (isPlaceholder(e.body)) exclude(kind ?? 'goal', 'context.md', e, null, 'placeholder');
    else if (kind) add(kind, 'context.md', e, null, { code: 'always' }, e.heading);
  }
  const ctxRest = ctxEntries.filter((e) => !/^(goal|constraint|command)/i.test(e.heading) && !isPlaceholder(e.body));

  // 2. état courant + dernière vérification
  const state = read(p.state).split('\n').filter((l) => l.startsWith('- ')).slice(0, 8).join('\n');
  if (state) add('state', 'state.md', { heading: 'Current state', body: state }, null, { code: 'latest' }, 'Current state');
  const last = listManifests(p, 1)[0];
  const lastVerify = last?.attempts.at(-1)?.verify;
  if (lastVerify?.length) {
    const line = lastVerify.map((v) => `${v.ok ? '✓' : '✗'} ${v.command}`).join(' · ');
    add('verification', 'tasks/' + last!.id + '.md', { heading: `Latest verification (${last!.status})`, body: line }, null, { code: 'latest' }, 'Latest verification');
  }

  // 3. entrées classées par pertinence : échecs, décisions, architecture
  const failures = parseEntries(read(p.failures)).map((e) => ({ e, src: 'failures.md' }));
  const decisions = parseEntries(read(p.decisions)).filter((e) => !isPlaceholder(e.body)).map((e) => ({ e, src: 'decisions.md' }));
  const archs = [...parseEntries(read(p.architecture)).filter((e) => !isPlaceholder(e.body)), ...ctxRest].map((e) => ({ e, src: ctxRest.includes(e) ? 'context.md' : 'architecture.md' }));
  const idf = idfOf([...failures, ...decisions, ...archs].map((x) => x.e));

  const pick = (list: { e: MdEntry; src: string }[], kind: ContextKind, cap: number, title: string, similar = false) => {
    const scored = list.map(({ e, src }) => ({ ...score(e, taskTerms, taskPaths, idf, now), source: src }));
    // « tâche déjà échouée » : le titre de la tâche partage l'essentiel de ses mots avec la demande
    const bySimilarity = (s: Scored) => {
      if (!similar) return false;
      const t = new Set(terms(s.entry.meta.task ?? ''));
      return t.size > 0 && taskTerms.filter((x) => t.has(x)).length / t.size >= 0.6;
    };
    const ranked = scored.sort((a, b) => b.score - a.score || (b.entry.date ?? '').localeCompare(a.entry.date ?? ''));
    let taken = 0;
    for (const s of ranked) {
      const pinned = s.entry.pinned;
      const sim = bySimilarity(s);
      const ok = pinned || sim || s.score >= threshold;
      if (ok && (taken < cap || pinned)) {
        taken++;
        add(kind, s.source, s.entry, s, pinned ? { code: 'pinned' } : sim ? { code: 'similar_failure', terms: s.matched } : s.fileHits.length ? { code: 'file_match', files: s.fileHits, terms: s.matched } : { code: 'relevant', terms: s.matched }, `${title}: ${s.entry.heading}`);
      } else exclude(kind, s.source, s.entry, s, ok ? 'cap' : 'below_threshold');
    }
  };
  pick(decisions, 'decision', cfg.memory.max_decisions, 'Decision');
  pick(failures, 'failure', cfg.memory.max_failures, 'Previous failure', true);
  pick(archs, 'architecture', 2, 'Architecture');

  // 4. fichiers probablement concernés (chemins uniquement : jamais leur contenu)
  const fileSet = new Set<string>(taskPaths);
  for (const b of blocks) {
    for (const f of b.item.reason.files ?? []) fileSet.add(f);
    for (const f of splitList(/files:\s*(.+)/i.exec(b.body)?.[1])) fileSet.add(f);
  }
  const files = [...fileSet].slice(0, 12);
  if (files.length) add('files', 'prompt + memory', { heading: 'Likely relevant files', body: files.map((f) => `- ${f}`).join('\n') }, null, { code: 'relevant', files }, 'Likely relevant files');

  // 5. budget : on garde dans l'ordre de priorité tant que ça tient
  const budget = cfg.memory.max_context_chars;
  const header = '[CodeBreak project context — selected for this task; the full memory is in .codebreak/]';
  const footer = '[End of project context]';
  let used = header.length + footer.length + 2;
  const kept: typeof blocks = [];
  for (const b of blocks.sort((a, b) => a.key - b.key)) {
    const size = b.title.length + b.body.length + 6;
    if (used + size > budget) {
      b.item.included = false;
      b.item.reason = { code: 'over_budget', terms: b.item.reason.terms };
      continue;
    }
    used += size;
    kept.push(b);
  }
  const text = kept.length ? [header, ...kept.map((b) => `\n### ${b.title}\n${b.body}`), `\n${footer}`].join('\n') : '';
  const count = (k: ContextKind) => kept.filter((b) => b.item.kind === k).length;
  return {
    text,
    items,
    budget,
    usedChars: text.length,
    files,
    counts: { files: files.length, decisions: count('decision'), failures: count('failure'), chars: text.length },
  };
}

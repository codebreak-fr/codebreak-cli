import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { contextFilePath } from '../config/paths.js';
import type { Config } from '../config/schema.js';
import type { Target } from '../types.js';

const HEADER = (project: string) =>
  `# Contexte partagé CodeBreak — ${project}\n` +
  `_Généré automatiquement pour que chaque outil sache ce qu'un autre a déjà fait dans cette session, ` +
  `et évite de relire le dépôt ou de refaire un travail déjà en place. Pas destiné à être commité._\n`;

export interface ContextEntry {
  n: number;
  target: Target;
  prompt: string;
  summary: string;
  filesChanged: string[];
  at: number;
}

function entryBlock(e: ContextEntry): string {
  const when = new Date(e.at).toLocaleString('fr-FR');
  const lines = [
    `## Tour ${e.n} — ${e.target.label} (${when})`,
    `**Demande :** ${e.prompt.replace(/\s+/g, ' ').slice(0, 240)}`,
  ];
  if (e.filesChanged.length) lines.push(`**Fichiers modifiés :** ${e.filesChanged.slice(0, 20).join(', ')}`);
  const summary = e.summary.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (summary) lines.push(`**Résumé :** ${summary}`);
  return lines.join('\n');
}

/** Découpe le fichier existant en (en-tête ignoré, blocs `## Tour N`). */
function parseBlocks(raw: string): string[] {
  const parts = raw.split(/\n(?=## Tour )/g);
  return parts.filter((p) => p.startsWith('## Tour '));
}

function lastTourNumber(blocks: string[]): number {
  const m = /^## Tour (\d+)/.exec(blocks.at(-1) ?? '');
  return m ? Number(m[1]) : blocks.length;
}

/** Ajoute un tour au fichier de contexte du projet, en purgeant les plus anciens au-delà de `max_entries`. */
export function appendContext(
  cwd: string,
  cfg: Config,
  entry: Omit<ContextEntry, 'n' | 'at'>,
): void {
  if (!cfg.context.enabled) return;
  const path = contextFilePath(cwd);
  const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const blocks = parseBlocks(existing);
  const n = lastTourNumber(blocks) + 1;
  blocks.push(entryBlock({ ...entry, n, at: Date.now() }));
  const kept = blocks.slice(-Math.max(1, cfg.context.max_entries));
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${HEADER(project)}\n${kept.join('\n\n')}\n`, 'utf8');
    renameSync(tmp, path);
  } catch {
    /* le contexte est un confort, jamais bloquant */
  }
}

/** Contenu brut du fichier de contexte (vide si absent ou désactivé). */
export function readContext(cwd: string, cfg: Config): string {
  if (!cfg.context.enabled) return '';
  const path = contextFilePath(cwd);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Référence courte à donner au prochain backend au lieu de lui réinjecter tout l'historique en clair :
 * une seule ligne (quelques dizaines de tokens) plutôt que les échanges complets à chaque changement d'outil.
 * Seulement utile pour les cibles qui peuvent lire le dépôt (caps.tools) ; les autres n'ont pas de quoi la lire.
 */
export function contextReference(cwd: string, cfg: Config): string {
  if (!cfg.context.enabled) return '';
  const path = contextFilePath(cwd);
  if (!existsSync(path)) return '';
  const rel = relative(cwd, path);
  const shown = rel.startsWith('..') ? path : rel;
  return (
    `[Contexte de session] D'autres outils ont déjà travaillé sur cette tâche. ` +
    `Avant de relire tout le dépôt ou de refaire un travail déjà fait, consulte « ${shown} » ` +
    `(demandes précédentes, fichiers déjà modifiés, résumé des résultats).`
  );
}

/**
 * Dossier du fichier de contexte, à ouvrir aux backends qui confinent leurs outils au dépôt
 * (claude --add-dir, gemini --include-directories) : sinon la lecture est refusée hors du cwd.
 */
export function contextDir(cwd: string, cfg: Config): string {
  return cfg.context.enabled ? dirname(contextFilePath(cwd)) : '';
}

export function resetContext(cwd: string): void {
  const path = contextFilePath(cwd);
  try {
    if (existsSync(path)) writeFileSync(path, '', 'utf8');
  } catch {
    /* ignoré */
  }
}

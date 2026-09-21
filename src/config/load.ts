import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { globalConfigPath, projectConfigPath } from './paths.js';
import { ConfigSchema, type Config } from './schema.js';
import { t } from '../i18n/index.js';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Json, v) : v;
  }
  return out;
}

function readYaml(path: string): Json {
  if (!existsSync(path)) return {};
  try {
    const parsed = parse(readFileSync(path, 'utf8'));
    return isObj(parsed) ? parsed : {};
  } catch (e) {
    throw new Error(t('Config illisible ({path}) : {msg}', { path, msg: (e as Error).message }));
  }
}

export interface LoadedConfig {
  config: Config;
  globalPath: string;
  projectPath: string | null;
}

/** Fusionne défauts < config globale < .codebreak.yaml du projet. */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const globalPath = globalConfigPath();
  const projPath = projectConfigPath(cwd);
  const merged = deepMerge(readYaml(globalPath), readYaml(projPath));
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(t('Config invalide :\n{issues}', { issues }));
  }
  return { config: parsed.data, globalPath, projectPath: existsSync(projPath) ? projPath : null };
}

/** Écrit une clé pointée (ex. "router.model") dans la config globale. */
export function setConfigValue(dotted: string, value: unknown): void {
  const path = globalConfigPath();
  const data = readYaml(path);
  const keys = dotted.split('.');
  let cur: Json = data;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[keys[keys.length - 1]!] = value;
  const check = ConfigSchema.safeParse(data);
  if (!check.success) {
    throw new Error(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(data), 'utf8');
}

/** Interprète "true", "12", "a,b" ou du texte brut. */
export function parseCliValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      /* texte */
    }
  }
  return raw;
}

export function getConfigValue(config: Config, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), config);
}

export function defaultConfigYaml(): string {
  const cfg = ConfigSchema.parse({});
  return (
    t('# CodeBreak — configuration globale (les clés omises prennent leur valeur par défaut)\n') +
    t('# Un fichier .codebreak.yaml à la racine d’un projet surcharge ce fichier.\n') +
    stringify(cfg)
  );
}

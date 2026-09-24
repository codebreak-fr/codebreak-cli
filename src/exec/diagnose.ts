import { createHash } from 'node:crypto';
import { redact } from '../util/redact.js';
import type { VerifyStep } from './verify.js';

/**
 * Diagnostic d'un échec : à quelle famille appartient-il, est-il « simple » (le même agent peut le corriger) ou
 * structurel (il faut changer d'approche), et est-ce toujours le même problème d'une tentative à l'autre ?
 */

export type FailureKind =
  | 'syntax'
  | 'typecheck'
  | 'lint'
  | 'test'
  | 'compile'
  | 'environment'
  | 'dependency'
  | 'config'
  | 'architecture'
  | 'missing_context'
  | 'timeout'
  | 'agent'
  | 'no_change'
  | 'unknown';

export interface Diagnosis {
  kind: FailureKind;
  /** phrase courte, en anglais, sans secret */
  summary: string;
  /** identique d'une tentative à l'autre tant que c'est le même problème (numéros de ligne, durées, chemins absolus ignorés) */
  fingerprint: string;
  errorCount?: number;
  files: string[];
  command?: string;
  /** l'échec vient-il de l'environnement ou d'un manque de contexte plutôt que du code ? */
  confidence: 'high' | 'medium' | 'low';
}

export type CommandFamily = 'typecheck' | 'lint' | 'test' | 'build' | 'other';

export function commandFamily(command: string): CommandFamily {
  const c = command.toLowerCase();
  if (/\b(typecheck|type-check|check-types|tsc|mypy|pyright|cargo check|go vet)\b/.test(c)) return 'typecheck';
  if (/\b(lint|eslint|biome|ruff|flake8|clippy|rubocop|prettier --check)\b/.test(c)) return 'lint';
  if (/\b(test|tests|vitest|jest|pytest|mocha|cargo test|go test|rspec)\b/.test(c)) return 'test';
  if (/\b(build|compile|make|cargo build|go build|webpack|vite build|tsup|esbuild)\b/.test(c)) return 'build';
  return 'other';
}

const ENV = /(EADDRINUSE|EACCES|EPERM: operation not permitted|ENOSPC|No space left on device|ECONNREFUSED|ENOTFOUND|getaddrinfo|ETIMEDOUT|EAI_AGAIN|JavaScript heap out of memory|Killed\b|out of memory|Permission denied)/i;
const CONFIG = /(missing script|Missing script:|error TS5\d{3}|tsconfig[^\n]*(?:not found|invalid|error)|ESLint couldn't find|Failed to load config|eslint\.config[^\n]*error|Invalid configuration|Cannot find (?:jest|vitest|eslint) config|No test files found|no tests? found)/i;
const BARE_MODULE = /(?:Cannot find module|Cannot find package|Module not found: Error: Can't resolve|Could not resolve|ERR_MODULE_NOT_FOUND[^\n]*['"])\s*['"]?([^'"\s]+)['"]?/i;
const PY_MODULE = /No module named ['"]([^'"]+)['"]|ModuleNotFoundError/;
const DEP_OTHER = /(command not found|not found in PATH|npm ERR! code (?:E404|ERESOLVE)|ERESOLVE|peer dep|unable to resolve dependency|could not find crate|no matching package)/i;
const SYNTAX = /(SyntaxError|Unexpected token|Unexpected end of input|Unterminated (?:string|template|regular)|Parsing error|IndentationError|error TS1\d{3}\b|Expected [^\n]* but found|invalid syntax)/i;
const COMPILE = /(Failed to compile|error: could not compile|Build failed|✘ \[ERROR\]|ERROR in \.|error\[E\d+\]|compilation (?:failed|error))/i;
const ARCH = /(Circular dependency|circular import|Maximum call stack|cyclic)/i;
// erreurs TS qui trahissent un agent qui n'a pas vu le code existant
const CONTEXT_TS = new Set(['TS2304', 'TS2305', 'TS2339', 'TS2551', 'TS2724', 'TS2307', 'TS2345', 'TS2554']);

const PATH_IN_OUTPUT = /(\/?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,6})(?:[:(]\d+|\b)/g;

/** Chemins de fichiers cités dans une sortie (relatifs, sans node_modules), dédoublonnés. */
export function filesIn(output: string, cwd?: string): string[] {
  const seen = new Set<string>();
  for (const m of output.matchAll(PATH_IN_OUTPUT)) {
    let p = m[1]!;
    if (cwd && p.startsWith(cwd + '/')) p = p.slice(cwd.length + 1);
    if (p.startsWith('/') || p.includes('node_modules/') || /^\d/.test(p) || /^https?:/.test(p)) continue;
    seen.add(p);
  }
  return [...seen].slice(0, 12);
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Signature stable d'un échec : codes d'erreur + fichiers (sans numéros de ligne) ou sortie normalisée. */
function signatureOf(kind: FailureKind, output: string): string {
  const tsErrs = [...output.matchAll(/([\w./@-]+)\(\d+,\d+\): error (TS\d+)/g)].map((m) => `${m[2]}@${m[1]!.split('/').pop()}`);
  const tsErrs2 = [...output.matchAll(/([\w./@-]+):\d+:\d+ - error (TS\d+)/g)].map((m) => `${m[2]}@${m[1]!.split('/').pop()}`);
  if (tsErrs.length + tsErrs2.length) return `${kind}:${uniq([...tsErrs, ...tsErrs2]).sort().join(',')}`;
  const failing = [...output.matchAll(/^\s*(?:FAIL|✗|×|✕|●)\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, ''));
  if (failing.length) return `${kind}:${uniq(failing).sort().join('|')}`;
  const rules = [...output.matchAll(/\s(@?[\w-]+\/[\w-]+|[a-z][a-z-]+[a-z])\s*$/gm)].map((m) => m[1]!);
  const lint = kind === 'lint' ? uniq(rules).sort().slice(0, 12).join(',') : '';
  if (lint) return `${kind}:${lint}`;
  // repli : sortie normalisée
  const norm = output
    .split('\n')
    .slice(0, 60)
    .map((l) => l.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m)\b/g, '').replace(/:\d+(?::\d+)?/g, '').replace(/\(\d+,\d+\)/g, '').replace(/\/[\w./-]*\/([\w.-]+)/g, '$1').replace(/\b\d{4,}\b/g, '#').trim())
    .filter(Boolean)
    .join('\n');
  return `${kind}:${norm}`;
}

function countErrors(kind: FailureKind, output: string): number | undefined {
  const ts = output.match(/error TS\d+/g)?.length;
  if (ts) return ts;
  const failed = /(\d+)\s+(?:failed|failing)/i.exec(output);
  if (failed && (kind === 'test' || kind === 'unknown')) return Number(failed[1]);
  const problems = /(\d+)\s+problems?\b/.exec(output);
  if (problems) return Number(problems[1]);
  const py = /(\d+)\s+errors?\b/.exec(output);
  return py ? Number(py[1]) : undefined;
}

function summarize(kind: FailureKind, output: string, count: number | undefined, command: string): string {
  const codes = uniq(output.match(/\bTS\d{4}\b/g) ?? []).slice(0, 4).join(', ');
  switch (kind) {
    case 'typecheck':
    case 'missing_context':
    case 'architecture':
      return count ? `${count} type error${count > 1 ? 's' : ''}${codes ? ` (${codes})` : ''}` : 'type check failed';
    case 'test': {
      const names = uniq([...output.matchAll(/^\s*(?:FAIL|✗|×|✕|●)\s+(.+?)\s*$/gm)].map((m) => m[1]!)).slice(0, 2).join('; ');
      return `${count ? `${count} failing test${count > 1 ? 's' : ''}` : 'tests failed'}${names ? `: ${clip(names, 100)}` : ''}`;
    }
    case 'lint':
      return count ? `${count} lint problem${count > 1 ? 's' : ''}` : 'lint failed';
    case 'timeout':
      return `${command} timed out`;
    default: {
      const first = output.split('\n').map((l) => l.trim()).find((l) => /error|fail|cannot|not found|unexpected|refused|denied/i.test(l)) ?? output.split('\n').find((l) => l.trim()) ?? '';
      return clip(redact(first), 160) || `${kind} failure`;
    }
  }
}

export function diagnoseVerify(step: Pick<VerifyStep, 'command' | 'output' | 'exitCode' | 'timedOut'>, cwd?: string): Diagnosis {
  const output = redact(step.output ?? '');
  const family = commandFamily(step.command);
  const files = filesIn(output, cwd);
  const base = { command: step.command, files };
  const done = (kind: FailureKind, confidence: Diagnosis['confidence']): Diagnosis => {
    const errorCount = countErrors(kind, output);
    return { ...base, kind, confidence, errorCount, summary: summarize(kind, output, errorCount, step.command), fingerprint: hash(signatureOf(kind, output)) };
  };

  if (step.timedOut) return done('timeout', 'high');
  if (ENV.test(output)) return done('environment', 'high');
  const bare = BARE_MODULE.exec(output)?.[1];
  if ((bare && !/^[./]|^@\//.test(bare)) || PY_MODULE.test(output) || DEP_OTHER.test(output)) return done('dependency', 'high');
  if (CONFIG.test(output)) return done('config', 'medium');
  if (ARCH.test(output)) return done('architecture', 'medium');
  if (SYNTAX.test(output)) return done('syntax', 'high');

  const tsCodes = output.match(/\bTS\d{4}\b/g) ?? [];
  const nErr = tsCodes.length;
  if (family === 'typecheck' || nErr) {
    const ctx = tsCodes.filter((c) => CONTEXT_TS.has(c)).length;
    const distinctFiles = files.length;
    if (nErr >= 15 && distinctFiles >= 6) return done('architecture', 'medium');
    if (nErr >= 3 && ctx / nErr >= 0.6) return done('missing_context', 'medium');
    return done('typecheck', 'high');
  }
  if (COMPILE.test(output) || family === 'build') return done('compile', 'medium');
  if (family === 'lint') return done('lint', 'high');
  if (family === 'test') return done('test', 'high');
  return done('unknown', 'low');
}

/** Échec provenant de l'agent lui-même (quota, authentification, indisponibilité, plantage). */
export function diagnoseAgentError(err: { kind: 'quota' | 'auth' | 'crash' | 'unavailable' | string; message: string }): Diagnosis {
  const message = redact(err.message);
  return { kind: 'agent', summary: `${err.kind}: ${clip(message, 140)}`, fingerprint: hash(`agent:${err.kind}:${message.replace(/\d+/g, '#').slice(0, 80)}`), files: [], confidence: 'high' };
}

export function diagnoseNoChange(): Diagnosis {
  return { kind: 'no_change', summary: 'the agent reported a change but no file was modified', fingerprint: hash('no_change'), files: [], confidence: 'high' };
}

/** Familles d'échecs qu'un agent corrige normalement seul, sans changer d'approche. */
export const SIMPLE_KINDS: ReadonlySet<FailureKind> = new Set(['syntax', 'typecheck', 'lint', 'compile', 'test', 'dependency', 'config']);

export const KIND_LABEL: Record<FailureKind, string> = {
  syntax: 'erreur de syntaxe',
  typecheck: 'erreur de typage',
  lint: 'erreur de lint',
  test: 'tests en échec',
  compile: 'erreur de compilation',
  environment: 'problème d’environnement',
  dependency: 'dépendance manquante',
  config: 'erreur de configuration',
  architecture: 'problème d’architecture',
  missing_context: 'manque de contexte',
  timeout: 'délai dépassé',
  agent: 'échec de l’agent',
  no_change: 'aucune modification',
  unknown: 'échec non identifié',
};

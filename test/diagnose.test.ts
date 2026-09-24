import { describe, expect, it } from 'vitest';
import { commandFamily, diagnoseAgentError, diagnoseNoChange, diagnoseVerify, filesIn } from '../src/exec/diagnose.js';

const step = (command: string, output: string, extra: Partial<{ exitCode: number; timedOut: boolean }> = {}) => ({ command, output, exitCode: 1, timedOut: false, ...extra });
const ts = (file: string, line: number, code: string, msg = 'Type error') => `${file}(${line},5): error ${code}: ${msg}`;

describe('diagnostic des échecs', () => {
  it('familles de commandes', () => {
    expect(commandFamily('npm run -s typecheck')).toBe('typecheck');
    expect(commandFamily('pnpm run -s lint')).toBe('lint');
    expect(commandFamily('npm run -s test')).toBe('test');
    expect(commandFamily('npm run build')).toBe('build');
    expect(commandFamily('echo hi')).toBe('other');
  });

  it('erreurs de typage : nombre, codes, fichiers', () => {
    const out = [ts('src/a.ts', 3, 'TS2322'), ts('src/a.ts', 9, 'TS2322'), ts('src/b.ts', 1, 'TS2345')].join('\n');
    const d = diagnoseVerify(step('npm run -s typecheck', out));
    expect(d).toMatchObject({ kind: 'typecheck', errorCount: 3, files: ['src/a.ts', 'src/b.ts'] });
    expect(d.summary).toMatch(/3 type errors \(TS2322, TS2345\)/);
  });

  it('erreurs de syntaxe, lint, tests, compilation', () => {
    expect(diagnoseVerify(step('npm run -s typecheck', "src/a.ts(1,1): error TS1005: ';' expected.")).kind).toBe('syntax');
    expect(diagnoseVerify(step('npm run -s test', 'SyntaxError: Unexpected token }')).kind).toBe('syntax');
    expect(diagnoseVerify(step('npm run -s lint', '/x/src/a.ts\n  3:7  error  no-unused-vars\n✖ 4 problems (4 errors)')).kind).toBe('lint');
    const tests = diagnoseVerify(step('npm run -s test', ' FAIL  src/a.test.ts > adds numbers\n FAIL  src/b.test.ts > parses\n\n Tests  2 failed | 5 passed'));
    expect(tests).toMatchObject({ kind: 'test', errorCount: 2 });
    expect(tests.summary).toMatch(/2 failing tests/);
    expect(diagnoseVerify(step('npm run build', 'Build failed with 2 errors')).kind).toBe('compile');
  });

  it('dépendance : module « nu » manquant, mais pas un import relatif', () => {
    expect(diagnoseVerify(step('npm run -s test', "Error: Cannot find module 'zod'")).kind).toBe('dependency');
    expect(diagnoseVerify(step('npm run -s test', 'sh: vitest: command not found')).kind).toBe('dependency');
    expect(diagnoseVerify(step('npm run -s typecheck', ts('src/a.ts', 1, 'TS2307', "Cannot find module './missing.js'"))).kind).not.toBe('dependency');
  });

  it('environnement, configuration, délai', () => {
    expect(diagnoseVerify(step('npm run -s test', 'Error: listen EADDRINUSE: address already in use :::3000')).kind).toBe('environment');
    expect(diagnoseVerify(step('npm run -s test', 'ECONNREFUSED 127.0.0.1:5432')).kind).toBe('environment');
    expect(diagnoseVerify(step('npm run -s lint', 'npm error Missing script: "lint"')).kind).toBe('config');
    expect(diagnoseVerify(step('npm run -s typecheck', 'error TS5083: Cannot read file tsconfig.json')).kind).toBe('config');
    expect(diagnoseVerify(step('npm run -s test', 'still running…', { timedOut: true })).kind).toBe('timeout');
  });

  it('manque de contexte : l’agent invente des API qui n’existent pas', () => {
    const out = [ts('src/a.ts', 1, 'TS2304', "Cannot find name 'foo'"), ts('src/a.ts', 2, 'TS2339', "Property 'x' does not exist"), ts('src/b.ts', 3, 'TS2305', "Module has no exported member 'y'")].join('\n');
    expect(diagnoseVerify(step('npm run -s typecheck', out)).kind).toBe('missing_context');
  });

  it('architecture : beaucoup d’erreurs dans beaucoup de fichiers, ou dépendance circulaire', () => {
    const many = Array.from({ length: 18 }, (_, i) => ts(`src/m${i % 8}/f.ts`, i + 1, 'TS2322')).join('\n');
    expect(diagnoseVerify(step('npm run -s typecheck', many)).kind).toBe('architecture');
    expect(diagnoseVerify(step('npm run -s test', 'Circular dependency detected: a -> b -> a')).kind).toBe('architecture');
  });

  it('l’empreinte est stable quand seules les lignes changent, et distincte sinon', () => {
    const a = diagnoseVerify(step('npm run -s typecheck', ts('src/a.ts', 3, 'TS2322')));
    const moved = diagnoseVerify(step('npm run -s typecheck', ts('src/a.ts', 42, 'TS2322')));
    const other = diagnoseVerify(step('npm run -s typecheck', ts('src/a.ts', 3, 'TS2345')));
    expect(moved.fingerprint).toBe(a.fingerprint);
    expect(other.fingerprint).not.toBe(a.fingerprint);
    const t1 = diagnoseVerify(step('npm run -s test', ' FAIL  a.test.ts > x (12 ms)'));
    const t2 = diagnoseVerify(step('npm run -s test', ' FAIL  a.test.ts > x (873 ms)'));
    expect(t1.fingerprint).toBe(t2.fingerprint);
  });

  it('les secrets présents dans la sortie ne finissent pas dans le résumé', () => {
    const secret = 'ghp_' + 'Qq77'.repeat(10);
    const d = diagnoseVerify(step('echo', `fatal: could not read Password for 'https://${secret}@github.com'`));
    expect(d.summary).not.toContain(secret);
  });

  it('erreurs d’agent et absence de modification', () => {
    expect(diagnoseAgentError({ kind: 'quota', message: 'limit reached' })).toMatchObject({ kind: 'agent' });
    expect(diagnoseAgentError({ kind: 'quota', message: 'a 12' }).fingerprint).toBe(diagnoseAgentError({ kind: 'quota', message: 'a 99' }).fingerprint);
    expect(diagnoseNoChange().kind).toBe('no_change');
  });

  it('extrait les chemins relatifs, sans node_modules ni chemins absolus', () => {
    expect(filesIn('at /tmp/x/src/a.ts:12:3\n at node_modules/lib/x.js:1\n src/b.ts(4,1) and src/c/d.tsx:9', '/tmp/x')).toEqual(['src/a.ts', 'src/b.ts', 'src/c/d.tsx']);
  });
});

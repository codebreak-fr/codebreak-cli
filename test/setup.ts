import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLang } from '../src/i18n/index.js';

setLang('fr');
// jamais d'écriture dans l'état réel de l'utilisateur pendant les tests
process.env.CODEBREAK_HOME ??= mkdtempSync(join(tmpdir(), 'cb-test-home-'));

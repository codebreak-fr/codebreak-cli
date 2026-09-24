import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { render, renderToString } from 'ink';
import { defaultConfigYaml, getConfigValue, loadConfig, parseCliValue, setConfigValue } from './config/load.js';
import { globalConfigPath, historyPath } from './config/paths.js';
import { detectAll } from './detect/index.js';
import { describeDecision, freshUsage, runOneShot } from './oneshot.js';
import { pickRouterModel } from './router/classifier.js';
import { route } from './router/index.js';
import { availableModels, buildTargets, ALL_BACKENDS, defaultModelInfo, modelDefaultWrites, resolveTarget } from './router/targets.js';
import { CATALOG_ACTIONS, catalogCommand } from './commands/catalog.js';
import { describeToolsChange, parseModelArgs, parseToolsArgs, toolsWrites } from './commands/args.js';
import { readLedger, summarize } from './usage/ledger.js';
import { App } from './ui/App.js';
import { AllAiUsagePanel, Environment, ModelsTable, UsagePanel } from './ui/panels.js';
import { readJson, writeJson } from './util/store.js';
import pkg from '../package.json' with { type: 'json' };
import { enableMouse } from './ui/mouse.js';
import { resolveLang, setLang, t } from './i18n/index.js';

/** Aide : la clé française est traduite par `t()` ; `{version}` est injecté. */
const help = () =>
  t(`CodeBreak {version} — routeur LLM : choisit Claude Code, OpenCode, Ollama, Copilot, Gemini, Vibe, aider, LM Studio ou llama.cpp selon la tâche.

Usage
  codebreak                      ouvre l'interface interactive
  codebreak "ta demande"         interface interactive, demande déjà envoyée
  codebreak -p "ta demande"      non interactif : route, exécute, affiche le résultat
  codebreak route "ta demande"   affiche seulement la décision de routage (--json disponible)

Sous-commandes
  detect      LLM installés et activés, matériel, MLX, quota (masque les outils décochés dans /tools)
  models      cibles de routage disponibles
              models <ia>                   liste les modèles d'une IA · models <ia> <modèle> le fixe par défaut
              models recommend [catégorie]  modèles locaux adaptés à cette machine (--json, --refresh)
              models installed              modèles installés (Ollama, cache Hugging Face)
              models install <nom> --yes    installe un modèle du catalogue · models remove <nom> --yes le supprime
  tools       active/désactive les outils IA : sans argument liste, "on|off <outil…>", "reset"
  usage       usage de toutes les IA installées + quota Claude et statistiques
  config      path | init | get <clé> | set <clé> <valeur>

Options
  -p, --print            mode non interactif
  --use <cible>          force la cible : opus sonnet haiku local free copilot gemini vibe aider lms llama
  --profile <p>          eco | balanced | quality
  --lang <l>             fr | en | auto (interface language, default: system)
  --router <fournisseur[:modèle]>   ex. ollama:ministral-3:3b · opencode · claude:haiku · rules
  --dry-run              (avec -p) n'exécute pas
  --json                 sortie JSON
  --cwd <dossier>        dossier de travail
  -q, --quiet            réduit les messages
  --refresh              (models recommend|install) relit le catalogue en ligne
  -y, --yes              confirme install/remove sans question
  -v, --version · -h, --help
`, { version: pkg.version });

interface Args {
  positional: string[];
  print: boolean;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  refresh: boolean;
  yes: boolean;
  use?: string;
  lang?: string;
  profile?: string;
  router?: string;
  cwd: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], print: false, dryRun: false, json: false, quiet: false, refresh: false, yes: false, cwd: process.cwd(), help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const val = () => argv[++i];
    if (t === '-p' || t === '--print') a.print = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--json') a.json = true;
    else if (t === '-q' || t === '--quiet') a.quiet = true;
    else if (t === '--refresh') a.refresh = true;
    else if (t === '-y' || t === '--yes') a.yes = true;
    else if (t === '--use') a.use = val();
    else if (t === '--lang') a.lang = val();
    else if (t === '--profile') a.profile = val();
    else if (t === '--router') a.router = val();
    else if (t === '--cwd') a.cwd = resolve(val() ?? '.');
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '-v' || t === '--version') a.version = true;
    else a.positional.push(t);
  }
  return a;
}

/** Lit stdin s'il est alimenté par un pipe ; n'attend jamais un flux inactif (cron, CI, outils). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    let got = false;
    let timer = setTimeout(done, 250);
    function done() {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(data.trim());
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      got = true;
      data += chunk;
      clearTimeout(timer);
      timer = setTimeout(done, 2000);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    void got;
  });
}

const print = (node: Parameters<typeof renderToString>[0]) => console.log(renderToString(node, { columns: process.stdout.columns ?? 110 }));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.lang && !['fr', 'en', 'auto'].includes(args.lang)) throw new Error('--lang: fr | en | auto');
  if (args.lang && args.lang !== 'auto') process.env.CODEBREAK_LANG = args.lang;
  setLang(resolveLang()); // provisoire (aide, version) ; la config peut préciser ensuite
  if (args.version) return console.log(pkg.version);
  if (args.help) return console.log(help());

  let { config: cfg } = loadConfig(args.cwd);
  setLang(resolveLang(cfg.language));
  if (args.profile) {
    if (!['eco', 'balanced', 'quality'].includes(args.profile)) throw new Error(t('Profil inconnu : {profile}', { profile: args.profile }));
    cfg = { ...cfg, profile: args.profile as typeof cfg.profile };
  }
  if (args.router) {
    const [provider, ...m] = args.router.split(':');
    cfg = { ...cfg, router: { ...cfg.router, provider: provider as typeof cfg.router.provider, model: m.join(':') || 'auto' } };
  }

  const [sub, ...rest] = args.positional;

  // --- sous-commandes sans détection
  if (sub === 'config') {
    const [action, key, ...val] = rest;
    if (action === 'path') return console.log(globalConfigPath());
    if (action === 'init') {
      if (existsSync(globalConfigPath())) return console.log(t('Existe déjà : {v}', { v: globalConfigPath() }));
      mkdirSync(dirname(globalConfigPath()), { recursive: true });
      writeFileSync(globalConfigPath(), defaultConfigYaml(), 'utf8');
      return console.log(t('Créé : {v}', { v: globalConfigPath() }));
    }
    if (action === 'get' && key) return console.log(JSON.stringify(getConfigValue(cfg, key), null, 2));
    if (action === 'set' && key && val.length) {
      setConfigValue(key, parseCliValue(val.join(' ')));
      return console.log(`${key} = ${JSON.stringify(getConfigValue(loadConfig(args.cwd).config, key))}`);
    }
    return console.log(defaultConfigYaml());
  }

  process.stderr.write(t('[2mDétection des outils…[0m'));
  const det = await detectAll(cfg);
  process.stderr.write('\r\x1b[K');

  if (sub === 'detect') {
    const usage = await freshUsage(det, cfg);
    if (args.json) return console.log(JSON.stringify({ detection: det, usage, router: pickRouterModel(det, cfg) }, null, 2));
    print(<Environment det={det} usage={usage} cfg={cfg} router={pickRouterModel(det, cfg)} />);
    return console.log(`\n${det.hardware.recommendation}`);
  }
  if (sub === 'models') {
    const [action, ...more] = rest;
    if (CATALOG_ACTIONS.includes(action as (typeof CATALOG_ACTIONS)[number])) {
      return catalogCommand(action as (typeof CATALOG_ACTIONS)[number], more, { cfg, det, json: args.json, refresh: args.refresh, yes: args.yes, print });
    }
    // models <ia> [<modèle>] : modèle par défaut d'une IA
    const parsed = parseModelArgs(rest);
    if (!parsed.ok) throw new Error(parsed.error);
    const { backend, model } = parsed.value;
    if (!backend) {
      const t = buildTargets(det, cfg);
      if (args.json) return console.log(JSON.stringify(t, null, 2));
      return print(<ModelsTable targets={t} />);
    }
    if (!model) {
      const models = availableModels(backend, det, cfg);
      const info = defaultModelInfo(backend, cfg);
      if (args.json) return console.log(JSON.stringify({ current: info.value, available: models }, null, 2));
      console.log(t('actuel : {value}', { value: info.value }));
      if (models.length) console.log(t('disponibles : {v}', { v: models.join(', ') }));
      return;
    }
    for (const [key, val] of modelDefaultWrites(backend, model, cfg)) setConfigValue(key, val);
    return console.log(t('{backend} → modèle par défaut : {model}', { backend, model }));
  }
  if (sub === 'tools') {
    const state = Object.fromEntries(ALL_BACKENDS.map(({ id }) => [id, cfg[id].enabled]));
    if (rest.length === 0) {
      if (args.json) return console.log(JSON.stringify(state, null, 2));
      return console.log(
        ALL_BACKENDS.map(({ id, label }) => `${cfg[id].enabled ? '[x]' : '[ ]'} ${id.padEnd(10)} ${label.padEnd(18)} ${det[id].installed ? t('installé') : t('non installé')}`).join('\n') +
          t('\n\nDécoché = jamais appelé. Usage : codebreak tools on|off <outil…> · codebreak tools reset'),
      );
    }
    const change = parseToolsArgs(rest);
    if (!change.ok) throw new Error(change.error);
    for (const [key, val] of toolsWrites(change.value)) setConfigValue(key, val);
    return console.log(describeToolsChange(change.value));
  }
  if (sub === 'usage') {
    const usage = await freshUsage(det, cfg);
    const all = readLedger();
    const now = Date.now();
    print(<AllAiUsagePanel det={det} cfg={cfg} usage={usage} entries={all} />);
    return print(
      <UsagePanel usage={usage} cfg={cfg} today={summarize(all, new Date().setHours(0, 0, 0, 0))} week={summarize(all, now - 7 * 864e5)} all={summarize(all)} />,
    );
  }
  if (sub === 'route') {
    const prompt = rest.join(' ') || (await readStdin());
    if (!prompt) throw new Error(t('Usage : codebreak route "ta demande"'));
    const usage = await freshUsage(det, cfg);
    const forced = args.use ? resolveTarget(args.use, buildTargets(det, cfg)) : undefined;
    if (args.use && !forced) {
      const disabled = ALL_BACKENDS.filter((b) => !cfg[b.id].enabled).map((b) => b.id);
      throw new Error(t('Cible inconnue ou désactivée : {use}{v}', { use: args.use, v: disabled.length ? t(' (désactivés : {v} — codebreak tools on <outil>)', { v: disabled.join(', ') }) : '' }));
    }
    const { decision } = await route(prompt, { cwd: args.cwd, cfg, det, usage, forcedTarget: forced });
    return args.json
      ? console.log(JSON.stringify({ primary: decision.primary?.id ?? null, chain: decision.chain.map((x) => x.id), features: decision.features, quota: decision.quota, reasons: decision.reasons, warnings: decision.warnings }, null, 2))
      : console.log(describeDecision(decision));
  }

  // --- exécution
  const promptArg = args.positional.join(' ');
  const piped = await readStdin();
  const prompt = [promptArg, piped].filter(Boolean).join('\n\n');

  if (args.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (!prompt) throw new Error(t('Aucune demande. Usage : codebreak -p "ta demande"'));
    process.exitCode = await runOneShot({ prompt, cwd: args.cwd, cfg, det, force: args.use, json: args.json, dryRun: args.dryRun, quiet: args.quiet });
    return;
  }

  const history = readJson<string[]>(historyPath(), []);
  // Plein écran (écran alternatif) : la saisie reste en bas, l'historique défile dans cb, et le terminal
  // retrouve son contenu d'avant en quittant.
  const disableMouse = enableMouse();
  const app = render(
    <App
      version={pkg.version}
      cwd={args.cwd}
      cfg={cfg}
      det={det}
      initialPrompt={prompt || undefined}
      initialForce={args.use}
      history={history}
      onHistory={(h) => writeJson(historyPath(), h)}
    />,
    { exitOnCtrlC: false, alternateScreen: true },
  );
  try {
    await app.waitUntilExit();
  } finally {
    disableMouse();
  }
}

main().catch((e) => {
  process.stderr.write('\r\x1b[K');
  console.error(`✘ ${(e as Error).message}`);
  if (process.env.CODEBREAK_DEBUG) console.error((e as Error).stack);
  process.exit(1);
});

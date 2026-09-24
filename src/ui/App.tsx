import { Box, Text, useApp, useBoxMetrics, useInput, useWindowSize, type DOMElement } from 'ink';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConfigValue, loadConfig, parseCliValue, setConfigValue, defaultConfigYaml } from '../config/load.js';
import { contextFilePath, globalConfigPath } from '../config/paths.js';
import { ConfigSchema, type Config, type ProfileName } from '../config/schema.js';
import { detectAll, type Detection } from '../detect/index.js';
import { appendContext, contextDir, contextReference, readContext, resetContext } from '../exec/context.js';
import { runTask } from '../exec/runner.js';
import { pickRouterModel, type RouterModel } from '../router/classifier.js';
import { route } from '../router/index.js';
import { availableModels, buildTargets, ALL_BACKENDS, CONFIGURABLE_BACKENDS, defaultModelInfo, FORCE_ALIASES, modelDefaultWrites, resolveTarget } from '../router/targets.js';
import type { BackendId, ClaudeUsage, Decision, Target } from '../types.js';
import { getClaudeUsage, isFresh, loadUsage } from '../usage/claude.js';
import { readLedger, summarize } from '../usage/ledger.js';
import { InputBox, type AliasHint } from './InputBox.js';
import { CopyPicker, type CopyItem } from './CopyPicker.js';
import { ToolsPicker } from './ToolsPicker.js';
import { Discovery } from './discovery/Discovery.js';
import { isCategoryId } from '../catalog/categories.js';
import { useModelWrites, afterRemoveWrites } from '../catalog/actions.js';
import type { CategoryId } from '../catalog/types.js';
import { describeToolsChange, parseModelArgs, parseToolsArgs, toolsWrites } from '../commands/args.js';
import { Footer } from './Footer.js';
import { ItemView, type Item, type NewItem, type WelcomeProps } from './items.js';
import { Markdown } from './Markdown.js';
import { ContextPanel } from './ContextPanel.js';
import { buildContext } from '../memory/context-builder.js';
import { AllAiUsagePanel, Environment, HelpPanel, ModelsTable, UsagePanel } from './panels.js';
import { Picker, type PickerOption } from './Picker.js';
import { parseMouse } from './mouse.js';
import { Spinner } from './Spinner.js';
import { color } from './theme.js';
import { copyText } from '../util/clipboard.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveLang, setLang, t } from '../i18n/index.js';

export interface AppProps {
  version: string;
  cwd: string;
  cfg: Config;
  det: Detection;
  initialPrompt?: string;
  initialForce?: string;
  history: string[];
  onHistory: (h: string[]) => void;
}

interface Turn {
  prompt: string;
  backend: BackendId;
  text: string;
}

interface PickerState {
  title: string;
  options: PickerOption<() => void>[];
  initial?: number;
  /** Esc : par défaut ferme ; étape 2/2 de /models → retour à l'étape 1/2 */
  onCancel?: () => void;
}

/** Panneau interactif affiché à la place de la saisie (un seul à la fois). */
type Overlay = ({ kind: 'picker' } & PickerState) | { kind: 'tools' } | { kind: 'copy' } | { kind: 'discover'; category?: CategoryId };

const PROFILES: ProfileName[] = ['eco', 'balanced', 'quality'];

function buildRecap(turns: Turn[]): string {
  if (turns.length === 0) return '';
  const lines = turns.slice(-3).map((turn) => t('- Demande : {v}\n  Réponse : {v2}', { v: turn.prompt.slice(0, 300), v2: turn.text.replace(/\s+/g, ' ').slice(0, 400) }));
  return t('[Contexte : échanges précédents de cette session, menés avec un autre assistant]\n{v}\n[Fin du contexte]', { v: lines.join('\n') });
}

function latestCodeBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  return blocks.at(-1)?.[1]?.replace(/\n$/, '') || null;
}

/** Nombre d'entrées gardées à l'écran : au-delà, les plus anciennes ne sont plus dessinées (coût du rendu). */
const MAX_RENDERED = 300;

const MemoItem = memo(function MemoItem({ item }: { item: Item }) {
  return (
    <Box flexDirection="column">
      <ItemView item={item} />
    </Box>
  );
});

export function App(props: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const { cwd, version } = props;

  const [cfg, setCfgState] = useState(props.cfg);
  const [det, setDetState] = useState(props.det);
  const [usage, setUsageState] = useState<ClaudeUsage | null>(loadUsage());
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<{ label: string; startedAt: number } | null>(null);
  const [live, setLive] = useState('');
  const [tokens, setTokens] = useState(0);
  const [forced, setForced] = useState<string | undefined>(props.initialForce);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const setPicker = (p: PickerState | null) => setOverlay(p && { kind: 'picker', ...p });
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [history, setHistory] = useState(props.history);

  // refs : valeurs à jour dans les closures asynchrones
  const cfgRef = useRef(cfg);
  const detRef = useRef(det);
  const usageRef = useRef(usage);
  const forcedRef = useRef(forced);
  const idRef = useRef(0);
  const liveRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const sessionsRef = useRef<Partial<Record<BackendId, string>>>({});
  const turnsRef = useRef<Turn[]>([]);
  const lastRef = useRef<{ prompt: string; decision: Decision } | null>(null);
  const sessionOverrides = useRef<{ profile?: ProfileName; verify?: 'auto' | 'off' }>({});
  const exitArmed = useRef(0);
  const started = useRef(false);
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setCfg = (c: Config) => {
    cfgRef.current = c;
    setCfgState(c);
  };
  const setDet = (d: Detection) => {
    detRef.current = d;
    setDetState(d);
  };
  const setUsage = (u: ClaudeUsage | null) => {
    usageRef.current = u;
    setUsageState(u);
  };
  const setForcedBoth = (f?: string) => {
    forcedRef.current = f;
    setForced(f);
  };

  const notifyCopy = (message: string) => {
    setCopyNotice(message);
    if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
    copyNoticeTimer.current = setTimeout(() => setCopyNotice(null), 1800);
  };

  const router: RouterModel | null = useMemo(() => pickRouterModel(det, cfg), [det, cfg]);
  const targets = useMemo(() => buildTargets(det, cfg), [det, cfg]);
  const aliases: AliasHint[] = useMemo(
    () =>
      FORCE_ALIASES.map((a) => ({ name: `@${a}`, hint: resolveTarget(a, targets)?.label ?? 'indisponible' })).filter(
        (a) => a.hint !== 'indisponible',
      ),
    [targets],
  );

  const copyItems: CopyItem[] = useMemo(() => {
    const out: CopyItem[] = [];
    const add = (fallback: string, text: string) => {
      const t = text.trim();
      if (!t) return;
      out.push({ id: (out.length + 1) * 1000, label: (t.split('\n')[0]?.trim() || fallback).slice(0, 80), text: t });
    };
    for (const it of items) {
      switch (it.kind) {
        case 'user':
          add(t('Demande'), it.text);
          break;
        case 'assistant':
          add(t('Réponse'), it.text);
          break;
        case 'tool':
          add(it.name, `${it.name} : ${it.summary}`);
          break;
        case 'toolresult':
          add(t('Résultat d’outil'), it.preview);
          break;
        case 'escalate':
          add(t('Escalade'), `${it.from.label} → ${it.to.label} : ${it.reason}`);
          break;
        case 'warn':
          add('Avertissement', it.text);
          break;
        case 'error':
          add(t('Erreur'), it.text);
          break;
        case 'info':
          add('Info', it.text);
          break;
        default:
          break;
      }
    }
    return out;
  }, [items]);

  const push = useCallback((item: NewItem) => {
    setItems((prev) => [...prev, { ...item, id: ++idRef.current } as Item]);
  }, []);

  const welcomeProps = (): WelcomeProps => ({
    version,
    cwd,
    det: detRef.current,
    usage: usageRef.current,
    cfg: cfgRef.current,
    router: pickRouterModel(detRef.current, cfgRef.current),
  });

  const flushLive = () => {
    const text = liveRef.current;
    liveRef.current = '';
    setLive('');
    if (text.trim()) push({ kind: 'assistant', text });
  };

  /** Recharge la config depuis le disque en conservant les choix de session. */
  const reloadConfig = () => {
    const loaded = loadConfig(cwd).config;
    setLang(resolveLang(loaded.language));
    const o = sessionOverrides.current;
    setCfg({
      ...loaded,
      profile: o.profile ?? loaded.profile,
      verify: { ...loaded.verify, mode: o.verify ?? loaded.verify.mode },
    });
  };

  const refreshDetection = async () => {
    const d = await detectAll(cfgRef.current);
    setDet(d);
    if (d.claude.ready) {
      const u = await getClaudeUsage(d.claude.path, cfgRef.current, { force: true });
      if (u) setUsage(u);
    }
    return d;
  };

  // --- exécution d'une décision de routage
  const execute = async (prompt: string, decision: Decision, ac: AbortController) => {
    const t0 = Date.now();
    let totalTokens = 0;
    let totalCost = 0;
    const pendingSessions: Partial<Record<BackendId, string>> = {};
    let finalText = '';
    let lastTarget: Target | null = null;

    setBusy({ label: `${decision.primary!.label}`, startedAt: Date.now() });
    // contexte projet : seulement ce qui se rapporte à la demande (voir /context why)
    const contextPack = buildContext(cwd, cfgRef.current, prompt);
    if (contextPack.text) push({ kind: 'info', text: t('Contexte projet : {files} fichier(s), {decisions} décision(s), {failures} échec(s) précédent(s) ({chars} caractères)', contextPack.counts) });
    for await (const ev of runTask({
      prompt,
      decision,
      cwd,
      cfg: cfgRef.current,
      det: detRef.current,
      signal: ac.signal,
      sessions: sessionsRef.current,
      contextText: contextPack.text,
      recap: buildRecap(turnsRef.current),
      recapFile: contextReference(cwd, cfgRef.current),
    })) {
      switch (ev.type) {
        case 'attempt':
          flushLive();
          lastTarget = ev.target;
          setBusy({ label: ev.n > 1 ? t('{label} (tentative {n}/{total})', { label: ev.target.label, n: ev.n, total: ev.total }) : ev.target.label, startedAt: Date.now() });
          break;
        case 'run': {
          const e = ev.event;
          if (e.type === 'text') {
            if (e.delta) {
              liveRef.current += e.text;
              setLive(liveRef.current);
            } else {
              flushLive();
              push({ kind: 'assistant', text: e.text });
            }
          } else if (e.type === 'reasoning') {
            flushLive();
            push({ kind: 'reasoning', text: e.text });
          } else if (e.type === 'tool') {
            flushLive();
            push({ kind: 'tool', name: e.name, summary: e.summary });
          } else if (e.type === 'tool_result') {
            push({ kind: 'toolresult', ok: e.ok, preview: e.preview });
          } else if (e.type === 'usage') {
            totalTokens += e.inputTokens + e.outputTokens;
            totalCost += e.costUsd ?? 0;
            setTokens(totalTokens);
          } else if (e.type === 'rate') {
            setUsage(loadUsage());
          } else if (e.type === 'session') {
            pendingSessions[ev.target.backend] = e.id;
          } else if (e.type === 'error') {
            flushLive();
            push({ kind: 'error', text: `${ev.target.label} : ${e.message}` });
          } else if (e.type === 'handoff') {
            push({ kind: 'info', text: e.message });
          }
          break;
        }
        case 'verify_start':
          flushLive();
          setBusy({ label: t('Vérification'), startedAt: Date.now() });
          break;
        case 'verify_result':
          push({ kind: 'verify', result: ev.result });
          break;
        case 'escalate':
          flushLive();
          push({ kind: 'escalate', from: ev.from, to: ev.to, reason: ev.reason });
          break;
        case 'done':
          flushLive();
          finalText = ev.text;
          push({
            kind: 'done',
            ok: ev.ok,
            target: ev.target ?? lastTarget,
            ms: Date.now() - t0,
            tokens: totalTokens,
            costUsd: totalCost,
            verified: ev.verified,
            handoff: ev.handoff,
            message: ev.message,
          });
          if (ev.ok && ev.target) {
            sessionsRef.current = { ...sessionsRef.current, ...pendingSessions };
            turnsRef.current.push({ prompt, backend: ev.target.backend, text: finalText });
            appendContext(cwd, cfgRef.current, {
              target: ev.target,
              prompt,
              summary: finalText,
              filesChanged: ev.filesChanged ?? [],
            });
          }
          break;
      }
    }
  };

  const submitPrompt = async (raw: string, forceAlias?: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = Date.now();
    setTokens(0);
    setBusy({ label: t('Analyse de la demande'), startedAt: t0 });
    try {
      const c = cfgRef.current;
      const d = detRef.current;
      let u = usageRef.current;
      if (d.claude.ready && !isFresh(u, c.quota.claude.probe_ttl_min)) {
        setBusy({ label: t('Lecture du quota Claude'), startedAt: Date.now() });
        u = (await getClaudeUsage(d.claude.path, c)) ?? u;
        setUsage(u);
      }
      setBusy({ label: 'Routage', startedAt: t0 });
      const alias = forceAlias ?? forcedRef.current;
      const allTargets = buildTargets(d, c);
      const forcedTarget = alias ? resolveTarget(alias, allTargets) : undefined;
      if (alias && !forcedTarget) {
        push({ kind: 'warn', text: t('@{alias} est désactivé ou indisponible (/tools pour réactiver) — routage automatique.', { alias }) });
      }
      const { prompt, decision } = await route(raw, { cwd, cfg: c, det: d, usage: u, forcedTarget });
      push({ kind: 'route', decision });
      lastRef.current = { prompt, decision };
      if (!decision.primary) {
        push({ kind: 'error', text: t('Rien à exécuter : aucune cible disponible pour cette demande.') });
        return;
      }
      await execute(prompt, decision, ac);
    } catch (e) {
      flushLive();
      push({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      abortRef.current = null;
      setUsage(loadUsage() ?? usageRef.current);
    }
  };

  // --- commandes slash
  const handleCommand = async (text: string) => {
    const [cmd = '', ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ');
    const c = cfgRef.current;
    const d = detRef.current;
    const node = (n: React.ReactNode) => push({ kind: 'node', node: n });

    switch (cmd.toLowerCase()) {
      case '/help':
        return node(<HelpPanel />);

      case '/detect': {
        setBusy({ label: t('Détection des outils, du matériel et du quota'), startedAt: Date.now() });
        try {
          const nd = await refreshDetection();
          node(<Environment det={nd} usage={usageRef.current} cfg={cfgRef.current} router={pickRouterModel(nd, cfgRef.current)} />);
          node(<Text color={color.dim}>{nd.hardware.recommendation}</Text>);
        } finally {
          setBusy(null);
        }
        return;
      }

      case '/tools': {
        // /tools seul : liste interactive à bascule · /tools on|off <outil…> · /tools reset
        if (rest.length === 0) return setOverlay({ kind: 'tools' });
        const change = parseToolsArgs(rest);
        if (!change.ok) return push({ kind: 'error', text: change.error });
        try {
          applyWrites(toolsWrites(change.value));
          return push({ kind: 'info', text: t('{v} (enregistré dans {v2})', { v: describeToolsChange(change.value), v2: globalConfigPath() }) });
        } catch (e) {
          return push({ kind: 'error', text: (e as Error).message });
        }
      }

      case '/usage': {
        const all = readLedger();
        const now = Date.now();
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        node(<AllAiUsagePanel det={d} cfg={c} usage={usageRef.current} entries={all} />);
        return node(
          <UsagePanel usage={usageRef.current} cfg={c} today={summarize(all, startOfDay)} week={summarize(all, now - 7 * 864e5)} all={summarize(all)} />,
        );
      }

      case '/models': {
        // Tableau des cibles + choix guidé du modèle par défaut en 2 étapes.
        // Esc à l'étape 1 = tableau seul ; Esc à l'étape 2 = retour étape 1.
        const parsed = parseModelArgs(rest);
        if (!parsed.ok) return push({ kind: 'error', text: parsed.error });
        const { backend: backendArg, model: modelArg } = parsed.value;

        const persistDefault = (backend: BackendId, value: string) => {
          try {
            for (const [key, val] of modelDefaultWrites(backend, value, cfgRef.current)) setConfigValue(key, val);
            reloadConfig();
            push({ kind: 'info', text: t('{backend} → modèle par défaut : {v} (enregistré dans {v2})', { backend, v: value || 'auto', v2: globalConfigPath() }) });
          } catch (e) {
            push({ kind: 'error', text: (e as Error).message });
          }
        };

        const openModelStep = (backend: BackendId) => {
          const models = availableModels(backend, d, c);
          if (!models.length) {
            return push({ kind: 'info', text: t('Aucun modèle détecté pour {backend}. Usage : /models {backend2} <nom-du-modèle>', { backend, backend2: backend }) });
          }
          const info = defaultModelInfo(backend, c);
          // valeur par défaut réelle du schéma (pas '' : gemini par ex. attend littéralement "auto")
          const resetValue = backend === 'opencode' ? '' : (getConfigValue(ConfigSchema.parse({}), info.key) as string);
          setPicker({
            title: t('Étape 2/2 — Modèle par défaut pour {backend} (actuel : {value})', { backend, value: info.value }),
            options: [
              { label: 'auto'.padEnd(46), hint: t('laisse CodeBreak choisir'), value: () => persistDefault(backend, resetValue) },
              ...models.map((m) => ({ label: m.padEnd(46), hint: m === info.value ? 'actuel' : '', value: () => persistDefault(backend, m) })),
            ],
            initial: Math.max(0, models.findIndex((m) => m === info.value) + 1),
            onCancel: () => openBackendStep(),
          });
        };

        const openBackendStep = () => {
          const installed = CONFIGURABLE_BACKENDS.filter((b) => d[b].installed);
          if (!installed.length) {
            return push({ kind: 'info', text: t('Aucune IA configurable détectée. Usage : /models <ia> <nom-du-modèle>') });
          }
          setPicker({
            title: t('Étape 1/2 — Pour quelle IA choisir le modèle par défaut ?'),
            options: installed.map((b) => ({
              label: b.padEnd(46),
              hint: t('actuel : {value}', { value: defaultModelInfo(b, c).value }),
              value: () => openModelStep(b),
            })),
          });
        };

        if (backendArg) {
          // /models <ia> <modèle> : application directe · /models <ia> : direct à l'étape 2/2
          return modelArg ? persistDefault(backendArg, modelArg) : openModelStep(backendArg);
        }
        // /models seul : tableau des cibles, puis étape 1/2
        node(<ModelsTable targets={buildTargets(d, c)} />);
        return openBackendStep();
      }

      case '/discover': {
        // Discovery : modèles locaux adaptés à cette machine (catalogue en ligne), installation et suppression
        if (arg && !isCategoryId(arg.toLowerCase())) {
          return push({ kind: 'error', text: t('Catégorie inconnue : {arg}. Essaie coding, general, reasoning, vision, rag, embeddings, reranking, stt, tts, image, video, ocr, agents.', { arg }) });
        }
        return setOverlay({ kind: 'discover', category: arg ? (arg.toLowerCase() as CategoryId) : undefined });
      }

      case '/context': {
        const sub = arg.trim().toLowerCase();
        if (sub === 'why' || sub.startsWith('why ')) {
          const task = arg.trim().slice(3).trim() || lastRef.current?.prompt || '';
          if (!task) return push({ kind: 'info', text: t('Usage : /context why <tâche> (ou après une demande)') });
          return node(<ContextPanel pack={buildContext(cwd, c, task)} task={task} />);
        }
        const path = contextFilePath(cwd);
        if (sub === 'clear') {
          resetContext(cwd);
          return push({ kind: 'info', text: t('Contexte partagé effacé ({path}).', { path }) });
        }
        const content = readContext(cwd, c);
        if (!content.trim()) {
          return push({ kind: 'info', text: t('Aucun contexte partagé pour ce projet. Il se remplit au fil des tours ({path}).', { path }) });
        }
        return node(
          <Box flexDirection="column">
            <Text bold>{t('Contexte partagé — ')}{path}</Text>
            <Markdown text={content} />
          </Box>,
        );
      }

      case '/router': {
        if (arg) {
          const [provider, ...m] = arg.split(/\s+/);
          try {
            setConfigValue('router.provider', provider);
            setConfigValue('router.model', m.join(' ') || 'auto');
            reloadConfig();
            const rm = pickRouterModel(detRef.current, cfgRef.current);
            return push({ kind: 'info', text: t('Routeur → {v} (enregistré dans {v2})', { v: rm ? rm.label : t('règles seules'), v2: globalConfigPath() }) });
          } catch (e) {
            return push({ kind: 'error', text: (e as Error).message });
          }
        }
        const choose = (provider: string, model: string) => () => {
          try {
            setConfigValue('router.provider', provider);
            setConfigValue('router.model', model);
            reloadConfig();
            const rm = pickRouterModel(detRef.current, cfgRef.current);
            push({ kind: 'info', text: t('Routeur → {v}', { v: rm ? rm.label : t('règles seules') }) });
          } catch (e) {
            push({ kind: 'error', text: (e as Error).message });
          }
        };
        const cur = pickRouterModel(d, c);
        const options: PickerOption<() => void>[] = [
          { label: 'Automatique'.padEnd(46), hint: t('petit modèle Ollama → OpenCode gratuit → Haiku'), value: choose('auto', 'auto') },
          ...d.ollama.models
            .filter((m) => m.capabilities.includes('completion') && m.fits)
            .sort((a, b) => a.sizeGB - b.sizeGB)
            .map((m) => ({
              label: `ollama/${m.name}`.padEnd(46),
              hint: t('{sizeGB} Go · local, gratuit{v}', { sizeGB: m.sizeGB, v: m.loaded ? t(' · chargé') : '' }),
              value: choose('ollama', m.name),
            })),
          ...d.opencode.freeModels.map((m) => ({ label: m.padEnd(46), hint: t('OpenCode · gratuit, cloud'), value: choose('opencode', m) })),
          ...(d.claude.ready ? [{ label: 'claude/haiku'.padEnd(46), hint: t('consomme du quota Claude'), value: choose('claude', 'haiku') }] : []),
          { label: t('Règles seules').padEnd(46), hint: t('aucun LLM pour classer'), value: choose('rules', 'auto') },
        ];
        setPicker({
          title: t('Quel LLM joue le rôle de routeur ? (actuel : {v})', { v: cur ? cur.label : t('règles seules') }),
          options,
          initial: Math.max(0, options.findIndex((o) => cur && o.label.trim() === cur.label)),
        });
        return;
      }

      case '/profile': {
        if (!PROFILES.includes(arg as ProfileName)) {
          return push({ kind: 'info', text: t('Profil actuel : {profile}. Usage : /profile {v}  (pour toute la session ; /config set profile <p> pour l’enregistrer)', { profile: c.profile, v: PROFILES.join('|') }) });
        }
        sessionOverrides.current.profile = arg as ProfileName;
        setCfg({ ...c, profile: arg as ProfileName });
        return push({ kind: 'info', text: t('Profil → {arg}', { arg }) });
      }

      case '/use': {
        if (!arg || arg === 'auto') {
          setForcedBoth(undefined);
          return push({ kind: 'info', text: t('Routage automatique rétabli.') });
        }
        const target = resolveTarget(arg, buildTargets(d, c));
        if (!target) {
          const disabled = ALL_BACKENDS.filter((b) => !c[b.id].enabled).map((b) => b.id);
          const hint = disabled.length ? t(' (désactivés : {v} — /tools pour réactiver)', { v: disabled.join(', ') }) : '';
          return push({ kind: 'error', text: t('Cible inconnue ou désactivée : {arg}{hint}. Essaie {v}.', { arg, hint, v: FORCE_ALIASES.join(', ') }) });
        }
        setForcedBoth(arg);
        return push({ kind: 'info', text: t('Cible forcée → {label} (jusqu’à /use auto).', { label: target.label }) });
      }

      case '/route': {
        if (!arg) return push({ kind: 'info', text: t('Usage : /route <prompt>') });
        setBusy({ label: 'Routage', startedAt: Date.now() });
        try {
          const u = usageRef.current;
          const t = forcedRef.current ? resolveTarget(forcedRef.current, buildTargets(d, c)) : undefined;
          const { decision } = await route(arg, { cwd, cfg: c, det: d, usage: u, forcedTarget: t });
          push({ kind: 'route', decision, dryRun: true });
        } finally {
          setBusy(null);
        }
        return;
      }

      case '/retry': {
        const last = lastRef.current;
        if (!last) return push({ kind: 'info', text: t('Rien à relancer.') });
        let alias = arg.replace(/^@/, '');
        if (!alias) {
          const usedLevel = Math.max(...last.decision.chain.map((t) => t.level), last.decision.primary?.level ?? 0);
          const up = buildTargets(d, c)
            .filter((t) => t.level > usedLevel && t.caps.capture)
            .sort((a, b) => a.level - b.level || b.power - a.power)[0];
          alias = up ? up.id : 'sonnet';
        }
        return submitPrompt(last.prompt, alias);
      }

      case '/verify': {
        if (arg !== 'on' && arg !== 'off') return push({ kind: 'info', text: t('Vérification : {v}. Usage : /verify on|off', { v: c.verify.mode === 'off' ? 'off' : 'auto' }) });
        const mode = arg === 'on' ? 'auto' : 'off';
        sessionOverrides.current.verify = mode;
        setCfg({ ...c, verify: { ...c.verify, mode } });
        return push({ kind: 'info', text: t('Vérification → {arg}', { arg }) });
      }

      case '/permissions': {
        const [sub = '', ...vals] = rest;
        const value = vals.join(' ').trim();
        const save = (key: string, v: unknown, msg: string) => {
          try {
            setConfigValue(key, v);
            reloadConfig();
            push({ kind: 'info', text: t('{msg} (enregistré dans {v})', { msg, v: globalConfigPath() }) });
          } catch (e) {
            push({ kind: 'error', text: (e as Error).message });
          }
        };
        const { allowed_tools: tools, add_dirs: dirs } = c.claude;
        if (sub === 'mode' && value) return save('claude.permission_mode', value, `Claude → mode ${value}`);
        if (sub === 'allow' && value) return save('claude.allowed_tools', [...tools.filter((t) => t !== value), value], t('Claude → outil autorisé : {value}', { value }));
        if (sub === 'deny' && value) return save('claude.allowed_tools', tools.filter((t) => t !== value), t('Claude → outil retiré : {value}', { value }));
        if (sub === 'dir' && value) return save('claude.add_dirs', [...dirs.filter((x) => x !== value), value], t('Claude → dossier accessible : {value}', { value }));
        if (sub === 'undir' && value) return save('claude.add_dirs', dirs.filter((x) => x !== value), t('Claude → dossier retiré : {value}', { value }));
        const ctx = contextDir(cwd, c);
        return node(
          <Box flexDirection="column">
            <Text bold>{t('Permissions de Claude (claude -p, non interactif : tout ce qui n’est pas autorisé est refusé)')}</Text>
            <Text color={color.dim}>  mode     {c.claude.permission_mode}  (default · acceptEdits · plan · bypassPermissions)</Text>
            <Text color={color.dim}>  outils   {tools.join(', ') || '—'}  {t('(+ lecture/édition dans le dépôt selon le mode)')}</Text>
            <Text color={color.dim}>  dossiers {[ctx && t('{ctx} (contexte partagé)', { ctx }), ...dirs].filter(Boolean).join(', ') || '—'}</Text>
            <Text color={color.dim}>  {t('/permissions mode acceptEdits · allow "Bash(git:*)" · deny WebFetch · dir ~/autre-dossier · undir &lt;chemin&gt;')}</Text>
          </Box>,
        );
      }

      case '/config': {
        const [sub, key, ...val] = rest;
        if (sub === 'path') return push({ kind: 'info', text: globalConfigPath() });
        if (sub === 'init') {
          if (existsSync(globalConfigPath())) return push({ kind: 'info', text: t('Existe déjà : {v}', { v: globalConfigPath() }) });
          mkdirSync(dirname(globalConfigPath()), { recursive: true });
          writeFileSync(globalConfigPath(), defaultConfigYaml(), 'utf8');
          return push({ kind: 'info', text: t('Créé : {v}', { v: globalConfigPath() }) });
        }
        if (sub === 'set' && key && val.length) {
          try {
            setConfigValue(key, parseCliValue(val.join(' ')));
            reloadConfig();
            return push({ kind: 'info', text: `${key} = ${JSON.stringify(getConfigValue(cfgRef.current, key))}` });
          } catch (e) {
            return push({ kind: 'error', text: (e as Error).message });
          }
        }
        return node(
          <Box flexDirection="column">
            <Text bold>{t('Configuration')}</Text>
            <Text color={color.dim}>  {t('fichier : ')}{globalConfigPath()} {t('(surcharge par projet : .codebreak.yaml)')}</Text>
            <Text color={color.dim}>  profil {c.profile} {t('· routeur ')}{c.router.provider}/{c.router.model} ({c.router.mode}{t(') · escalade ')}{c.escalation.max_attempts} {t('essais · vérif. ')}{c.verify.mode}</Text>
            <Text color={color.dim}>  {t('quota Claude : tendu ')}{c.quota.claude.soft} {t('· critique ')}{c.quota.claude.hard} {t('· coupé ')}{c.quota.claude.stop}</Text>
            <Text color={color.dim}>  {t('modifier : /config set router.model ministral-3:3b · /config init crée le fichier complet')}</Text>
          </Box>,
        );
      }

      case '/clear':
        setItems([]);
        setScroll(0);
        push({ kind: 'welcome', props: welcomeProps() });
        return;

      case '/exit':
        return exit();

      default:
        return push({ kind: 'error', text: t('Commande inconnue : {cmd}. /help pour la liste.', { cmd }) });
    }
  };

  const onSubmit = (text: string) => {
    if (busy) return;
    setScroll(0);
    const next = [...history, text].slice(-200);
    setHistory(next);
    props.onHistory(next);
    if (text.startsWith('/')) {
      push({ kind: 'user', text });
      void handleCommand(text).catch((e) => push({ kind: 'error', text: (e as Error).message }));
    } else {
      push({ kind: 'user', text });
      void submitPrompt(text);
    }
  };

  // --- raccourcis globaux
  useInput((input, key) => {
    const mouse = parseMouse(input);
    if (mouse) {
      if (mouse.kind === 'wheelUp') scrollBy(3);
      else if (mouse.kind === 'wheelDown') scrollBy(-3);
      else if (mouse.kind === 'press' && offset > 0 && mouse.y === jumpY && mouse.x >= jumpX && mouse.x < jumpX + jumpLabel.length) setScroll(0);
      return;
    }
    if (key.pageUp || key.pageDown) {
      scrollBy((key.pageUp ? 1 : -1) * Math.max(1, viewport.height - 2));
      return;
    }
    // pendant un sélecteur (Picker / ToolsPicker), Ink laisse chaque composant gérer ses touches ;
    // ici on ignore tout sauf la souris et le scroll pour ne pas interférer (ex. Ctrl+C = annuler).
    if (overlay && overlay.kind !== 'copy') return;
    if (key.ctrl && key.shift && input === 'c') {
      const source = live || [...items].reverse().find((item) => item.kind === 'assistant')?.text;
      const code = source ? latestCodeBlock(source) : null;
      if (!code) {
        notifyCopy(t('Aucun bloc de code à copier.'));
        return;
      }
      void copyText(code).then((ok) => notifyCopy(ok ? t('Texte copié') : t('Copie impossible sur ce système')));
      return;
    }
    if (overlay?.kind === 'copy') {
      if (key.ctrl && input === 'c') setOverlay(null);
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busy) {
        abortRef.current?.abort();
        return;
      }
      const now = Date.now();
      if (now - exitArmed.current < 1500) return exit();
      exitArmed.current = now;
      push({ kind: 'info', text: t('Ctrl+C encore une fois pour quitter.') });
      return;
    }
    if (key.escape && busy) {
      abortRef.current?.abort();
      return;
    }
    if (key.shift && key.tab && !busy) {
      const c = cfgRef.current;
      const next = PROFILES[(PROFILES.indexOf(c.profile) + 1) % PROFILES.length]!;
      sessionOverrides.current.profile = next;
      setCfg({ ...c, profile: next });
      return;
    }
    if (key.ctrl && input === 'y' && !busy) setOverlay({ kind: 'copy' });
  });

  // --- défilement de l'historique (plein écran : le terminal n'a plus de scrollback)
  // Le contenu est calé en bas de la zone d'historique ; `scroll` = nombre de lignes remontées.
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const [scroll, setScroll] = useState(0);
  const maxScroll = Math.max(0, content.height - viewport.height);
  const offset = Math.min(scroll, maxScroll);
  const maxScrollRef = useRef(maxScroll);
  maxScrollRef.current = maxScroll;
  const scrollBy = (n: number) => setScroll((s) => Math.max(0, Math.min(maxScrollRef.current, Math.min(s, maxScrollRef.current) + n)));
  // quand du contenu arrive pendant qu'on lit plus haut, la vue ne bouge pas
  const lastContentHeight = useRef(0);
  useEffect(() => {
    const delta = content.height - lastContentHeight.current;
    lastContentHeight.current = content.height;
    if (delta > 0) setScroll((s) => (s > 0 ? s + delta : 0));
  }, [content.height]);
  const jumpLabel = t(' Aller en bas (clic) ↓ ');
  const jumpX = Math.max(0, Math.floor((viewport.width - jumpLabel.length) / 2));
  const jumpY = viewport.top + viewport.height - 1;

  // --- démarrage
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    push({ kind: 'welcome', props: welcomeProps() });
    if (props.initialPrompt) {
      push({ kind: 'user', text: props.initialPrompt });
      void submitPrompt(props.initialPrompt);
    }
    // rafraîchit le quota en tâche de fond si le cache est périmé
    const d = detRef.current;
    if (d.claude.ready && !isFresh(usageRef.current, cfgRef.current.quota.claude.probe_ttl_min)) {
      void getClaudeUsage(d.claude.path, cfgRef.current).then((u) => u && setUsage(u));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** applique des écritures de config (ex. modèle par défaut) puis recharge la config */
  const applyWrites = (writes: [string, unknown][]) => {
    for (const [key, val] of writes) setConfigValue(key, val);
    reloadConfig();
  };

  const renderOverlay = (o: Overlay) => {
    const close = () => setOverlay(null);
    switch (o.kind) {
      case 'picker':
        return (
          <Picker
            title={o.title}
            options={o.options}
            initial={o.initial}
            onSelect={(fn) => {
              close();
              fn();
            }}
            onCancel={() => {
              close();
              o.onCancel?.();
            }}
          />
        );
      case 'tools':
        return (
          <ToolsPicker
            cfg={cfgRef.current}
            det={detRef.current}
            onCancel={close}
            onSubmit={(enabled) => {
              try {
                applyWrites(ALL_BACKENDS.map(({ id }) => [`${id}.enabled`, enabled[id]]));
                const off = ALL_BACKENDS.filter(({ id }) => !enabled[id]).map(({ id }) => id);
                push({
                  kind: 'info',
                  text: off.length
                    ? t('Outils désactivés : {v} — ils ne seront jamais appelés (enregistré dans {v2})', { v: off.join(', '), v2: globalConfigPath() })
                    : t('Tous les outils sont activés (enregistré dans {v})', { v: globalConfigPath() }),
                });
              } catch (e) {
                push({ kind: 'error', text: (e as Error).message });
              } finally {
                close();
              }
            }}
          />
        );
      case 'copy':
        return (
          <CopyPicker
            items={copyItems}
            onClose={close}
            onDone={(it) => {
              close();
              notifyCopy(t('Texte copié · {label}', { label: it.label }));
            }}
          />
        );
      case 'discover':
        return (
          <Discovery
            det={det}
            cfg={cfg}
            initialCategory={o.category}
            onClose={close}
            onDetect={refreshDetection}
            onNotice={(text, level = 'info') => push({ kind: level, text })}
            onUse={(m) => {
              const writes = useModelWrites(m, cfgRef.current);
              if (!writes) return push({ kind: 'warn', text: t('{name} : ce runtime n’est pas piloté par le routeur.', { name: m.name }) });
              try {
                applyWrites(writes);
                push({ kind: 'info', text: t('ollama → modèle par défaut : {name} (enregistré dans {v})', { name: m.name, v: globalConfigPath() }) });
                close();
              } catch (e) {
                push({ kind: 'error', text: (e as Error).message });
              }
            }}
            onRemoved={(m) => {
              try {
                applyWrites(afterRemoveWrites(m, cfgRef.current));
              } catch (e) {
                push({ kind: 'error', text: (e as Error).message });
              }
            }}
          />
        );
    }
  };

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box ref={viewportRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" justifyContent="flex-end">
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginBottom={-offset}>
          {items.slice(-MAX_RENDERED).map((item) => (
            <MemoItem key={item.id} item={item} />
          ))}
          {live ? (
            <Box marginTop={1}>
              <Text>⏺ </Text>
              <Box flexShrink={1}>
                <Markdown text={live} />
              </Box>
            </Box>
          ) : null}
          {busy ? (
            <Box marginTop={1}>
              <Spinner label={busy.label} startedAt={busy.startedAt} tokens={tokens} />
            </Box>
          ) : null}
          {copyNotice ? (
            <Box marginTop={1} paddingX={2}>
              <Text color={copyNotice === t('Texte copié') ? color.ok : color.warn}>☑ {copyNotice}</Text>
            </Box>
          ) : null}
        </Box>
        {offset > 0 ? (
          <Box position="absolute" bottom={0} left={jumpX}>
            <Text inverse>{jumpLabel}</Text>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        {overlay ? (
          renderOverlay(overlay)
        ) : (
          <InputBox
            disabled={Boolean(busy)}
            placeholder={busy ? t('en cours… (esc pour interrompre)') : t('Décris ta tâche — le routeur choisit le modèle')}
            history={history}
            aliases={aliases}
            width={columns}
            onSubmit={onSubmit}
            onNotice={(t) => push({ kind: 'info', text: t })}
          />
        )}
        <Footer cfg={cfg} usage={usage} router={router} forced={forced} cwd={cwd} columns={columns} />
      </Box>
    </Box>
  );
}

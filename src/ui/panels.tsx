import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { Config } from '../config/schema.js';
import type { Detection } from '../detect/types.js';
import type { RouterModel } from '../router/classifier.js';
import { defaultModelInfo } from '../router/targets.js';
import type { BackendId, ClaudeUsage, CostKind, Decision, Target } from '../types.js';
import { quotaState } from '../usage/claude.js';
import { usageByBackend, type LedgerEntry, type Summary } from '../usage/ledger.js';
import { bar, ellipsizePath, fmtDuration, fmtReset, fmtTokens, LEVEL_NAMES, pct, quotaColor, utilOf } from './format.js';
import { COMMANDS } from './commands.js';
import { MASCOT } from './mascot.js';
import { Label, Ok } from './kit/index.js';
import { color } from './theme.js';
import { num, t } from '../i18n/index.js';
import { fmtGB } from '../catalog/present.js';


export function QuotaLine({ usage, cfg, compact }: { usage: ClaudeUsage | null; cfg: Config; compact?: boolean }) {
  if (!usage) return <Text color={color.dim}>{t('Claude : quota inconnu')}</Text>;
  const u5 = utilOf(usage.fiveHour);
  const u7 = utilOf(usage.sevenDay);
  const q = cfg.quota.claude;
  const state = quotaState(usage, cfg);
  const cell = (label: string, u: number | null) =>
    u === null ? null : (
      <Text>
        <Text color={color.dim}>{label} </Text>
        <Text color={quotaColor(u, q.soft, q.hard)}>
          {bar(u)} {pct(u)}
        </Text>
      </Text>
    );
  return (
    <Text>
      <Text color={color.dim}>Claude </Text>
      {cell('5h', u5)}
      <Text color={color.dim}> · </Text>
      {cell('7j', u7)}
      {state === 'hard' || state === 'stop' ? <Text color={color.err}> ⚠</Text> : state === 'soft' ? <Text color={color.warn}> ⚠</Text> : null}
      {!compact && usage.sevenDay && (utilOf(usage.sevenDay) ?? 0) >= q.soft ? (
        <Text color={color.dim}> (7j {fmtReset(usage.sevenDay.resetsAt)})</Text>
      ) : null}
    </Text>
  );
}

export function Environment({
  det,
  usage,
  cfg,
  router,
}: {
  det: Detection;
  usage: ClaudeUsage | null;
  cfg: Config;
  router: RouterModel | null;
}) {
  const hw = det.hardware;
  const cores = hw.cores.performance ? `${hw.cores.performance}P+${hw.cores.efficiency ?? 0}E` : `${hw.cores.total}`;
  const localModels = det.ollama.models.filter((m) => m.capabilities.includes('completion'));
  return (
    <Box flexDirection="column">
      <Box>
        <Label>Machine</Label>
        <Text>
          {hw.chip} · {cores} {t('cœurs')}{hw.gpuCores ? ` · ${hw.gpuCores} GPU` : ''} · {hw.memoryGB} {t('Go')}
          {'  '}
          <Text color={hw.mlx.supported ? color.ok : color.warn}>MLX {hw.mlx.supported ? '✔' : '✘'}</Text>
          <Text color={color.dim}>
            {hw.mlx.pythonMlxLm ? t(' (mlx-lm installé)') : ''} · local ≤ {hw.localBudgetGB} {t('Go')}
            {hw.onBattery ? t(' · sur batterie') : ''}
            {hw.lowPowerMode ? t(' · économie d’énergie') : ''}
          </Text>
        </Text>
      </Box>
      {/* décoché dans /tools = absent de /detect (réactivable uniquement via /tools, qui montre tout) */}
      {cfg.claude.enabled ? (
        <Box>
          <Label>Claude</Label>
          <Ok ok={det.claude.ready} />
          <Text>
            {' '}
            {det.claude.installed ? `Claude Code ${det.claude.version ?? ''}` : 'absent'}
            <Text color={color.dim}> · {det.claude.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {cfg.claude.enabled && det.claude.ready ? (
        <Box>
          <Label>{''}</Label>
          <QuotaLine usage={usage} cfg={cfg} />
        </Box>
      ) : null}
      {cfg.opencode.enabled ? (
        <Box>
          <Label>OpenCode</Label>
          <Ok ok={det.opencode.ready} />
          <Text>
            {' '}
            {det.opencode.installed ? `OpenCode ${det.opencode.version ?? ''}` : 'absent'}
            <Text color={color.dim}> · {det.opencode.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {cfg.ollama.enabled ? (
        <Box>
          <Label>Ollama</Label>
          <Ok ok={det.ollama.ready} />
          <Text>
            {' '}
            {det.ollama.installed ? `Ollama ${det.ollama.version ?? ''}` : 'absent'}
            <Text color={color.dim}>
              {' '}
              · {localModels.length ? localModels.map((m) => `${m.name} (${fmtGB(m.sizeGB)}${m.fits ? '' : t(', trop gros')})`).join(', ') : det.ollama.detail}
            </Text>
          </Text>
        </Box>
      ) : null}
      {cfg.copilot.enabled ? (
        <Box>
          <Label>Copilot</Label>
          <Ok ok={det.copilot.ready} />
          <Text>
            {' '}
            <Text color={color.dim}>{det.copilot.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {det.gemini.installed && cfg.gemini.enabled ? (
        <Box>
          <Label>Gemini</Label>
          <Ok ok={det.gemini.ready} />
          <Text>
            {' '}
            {`Gemini CLI ${det.gemini.version ?? ''}`}
            <Text color={color.dim}> · {det.gemini.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {det.vibe.installed && cfg.vibe.enabled ? (
        <Box>
          <Label>Vibe</Label>
          <Ok ok={det.vibe.ready} />
          <Text>
            {' '}
            {`Mistral Vibe ${det.vibe.version ?? ''}`}
            <Text color={color.dim}> · {det.vibe.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {det.aider.installed && cfg.aider.enabled ? (
        <Box>
          <Label>aider</Label>
          <Ok ok={det.aider.ready} />
          <Text>
            {' '}
            {det.aider.version ? `aider ${det.aider.version}` : 'aider'}
            <Text color={color.dim}> · {det.aider.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {det.lms.installed && cfg.lms.enabled ? (
        <Box>
          <Label>LM Studio</Label>
          <Ok ok={det.lms.ready} />
          <Text>
            {' '}
            {`lms ${det.lms.version ?? ''}`}
            <Text color={color.dim}> · {det.lms.detail}</Text>
          </Text>
        </Box>
      ) : null}
      {det.llamacpp.installed && cfg.llamacpp.enabled ? (
        <Box>
          <Label>llama.cpp</Label>
          <Ok ok={det.llamacpp.ready} />
          <Text>
            {' '}
            {`llama.cpp ${det.llamacpp.version ?? ''}`}
            <Text color={color.dim}> · {det.llamacpp.detail}</Text>
          </Text>
        </Box>
      ) : null}
      <Box>
        <Label>{t('Routeur')}</Label>
        <Text>
          {router ? <Text color={color.route}>{router.label}</Text> : <Text color={color.warn}>{t('règles seules')}</Text>}
          <Text color={color.dim}> · mode {cfg.router.mode} {t('· profil ')}{cfg.profile}</Text>
        </Text>
      </Box>
      {det.inventory.apps.length || det.inventory.models.length ? (
        <Box>
          <Label>{t('IA locales')}</Label>
          <Text color={color.dim}>
            {det.inventory.apps.map((a) => a.name).join(', ') || t('aucune app')}
            {det.inventory.models.length
              ? t(' · {length} modèles hors Ollama ({v} Go)', { length: det.inventory.models.length, v: num(det.inventory.models.reduce((s, m) => s + m.sizeGB, 0), 1) })
              : ''}
          </Text>
        </Box>
      ) : null}
      {det.others.length ? (
        <Box>
          <Label>{t('Autres')}</Label>
          <Text color={color.dim}>
            {det.others.map((o) => o.name).join(', ')} {t('détectés (non routés pour l’instant)')}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** La mascotte en demi-blocs ▀ : la couleur de texte = pixel du haut, le fond = pixel du bas. */
function Mascot() {
  const rows: ReactNode[] = [];
  for (let y = 0; y < MASCOT.length; y += 2) {
    rows.push(
      <Text key={y}>
        {MASCOT[y]!.map((top, x) => {
          const bottom = MASCOT[y + 1]?.[x] ?? null;
          if (!top && !bottom) return ' ';
          if (!bottom) return <Text key={x} color={top!}>▀</Text>;
          if (!top) return <Text key={x} color={bottom}>▄</Text>;
          return <Text key={x} color={top} backgroundColor={bottom}>▀</Text>;
        })}
      </Text>,
    );
  }
  return <Box flexDirection="column" marginRight={2}>{rows}</Box>;
}

export function Welcome({
  version,
  cwd,
  ...env
}: { version: string; cwd: string; det: Detection; usage: ClaudeUsage | null; cfg: Config; router: RouterModel | null }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={color.brand} paddingX={2} flexDirection="row" alignSelf="flex-start">
        <Mascot />
        <Box flexDirection="column" justifyContent="center">
          <Text>
            <Text color={color.brand}>✻</Text> <Text bold>{t('Bienvenue dans CodeBreak')}</Text> <Text color={color.dim}>v{version}</Text>
          </Text>
          <Text color={color.dim}> </Text>
          <Text color={color.dim}>  {t('/help · /detect redétecte · /discover installe des modèles locaux · @opus, @local… forcent')}</Text>
          <Text color={color.dim}>  cwd : {ellipsizePath(cwd, 70)}</Text>
        </Box>
      </Box>
      <Box marginTop={1} paddingLeft={1}>
        <Environment {...env} />
      </Box>
    </Box>
  );
}

export function RouteView({ decision, dryRun }: { decision: Decision; dryRun?: boolean }) {
  const f = decision.features;
  const p = decision.primary;
  const dim = color.dim;
  const chain = decision.chain.length > 1 ? decision.chain.map((t) => t.label.replace(/^Claude /, '')).join(' → ') : null;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color.route}>⏺</Text> <Text bold>{dryRun ? 'Simulation' : 'Route'}</Text> <Text color={dim}>→</Text>{' '}
        {p ? <Text bold color={color.brand}>{p.label}</Text> : <Text color={color.err}>{t('aucune cible')}</Text>}
        <Text color={dim}>
          {' '}
          {t('· complexité ')}{f.complexity}/5 · {f.category}
          {f.security ? t(' · sécurité') : ''}
          {f.needsMcp ? ' · MCP' : ''}
        </Text>
      </Text>
      {decision.reasons.slice(0, 5).map((r, i) => (
        <Text key={i} color={dim}>
          {'  '}
          {i === 0 ? '⎿ ' : '  '}
          {r}
        </Text>
      ))}
      {chain ? (
        <Text color={dim}>
          {'    '}{t('escalade : ')}{chain}
        </Text>
      ) : null}
      <Text color={dim}>
        {'    '}{t('classifieur :')}{' '}
        {decision.classifierModel
          ? `${decision.classifierModel} · ${fmtDuration(decision.classifierMs ?? 0)}`
          : t('règles (confiance {v})', { v: f.confidence.toFixed(2) })}
      </Text>
      {decision.warnings.map((w, i) => (
        <Text key={i} color={color.warn}>
          {'    '}⚠ {w}
        </Text>
      ))}
    </Box>
  );
}

const flag = (v: boolean, s: string) => (v ? s : '·');

export function ModelsTable({ targets }: { targets: Target[] }) {
  const sorted = [...targets].sort((a, b) => a.level - b.level || b.power - a.power);
  return (
    <Box flexDirection="column">
      <Text bold>{t('Cibles de routage')}</Text>
      <Text color={color.dim}>
        {'  '}{t('niveau · coût · capacités (outils, MCP, vision, sortie capturée)')}</Text>
      {sorted.map((tg) => (
        <Text key={tg.id}>
          {'  '}
          <Text color={color.brand}>{String(tg.level)}</Text> <Text color={color.dim}>{t(LEVEL_NAMES[tg.level]).padEnd(8)}</Text>
          <Text>{tg.id.padEnd(54)}</Text>
          <Text color={tg.cost === 'free' ? color.ok : tg.cost === 'included' ? color.route : color.warn}>{tg.cost.padEnd(14)}</Text>
          <Text color={color.dim}>
            {flag(tg.caps.tools, t('outils'))} {flag(tg.caps.mcp, 'mcp')} {flag(tg.caps.vision, 'vision')} {flag(tg.caps.capture, 'capture')} {tg.caps.contextK}k
            {tg.terminal ? t(' · passation') : ''}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

const BACKEND_DESCRIPTORS: { id: BackendId; label: string; cost: CostKind }[] = [
  { id: 'claude', label: 'Claude Code', cost: 'subscription' },
  { id: 'opencode', label: 'OpenCode', cost: 'free' },
  { id: 'ollama', label: 'Ollama', cost: 'free' },
  { id: 'copilot', label: 'Copilot', cost: 'included' },
  { id: 'gemini', label: 'Gemini CLI', cost: 'free' },
  { id: 'vibe', label: 'Mistral Vibe', cost: 'subscription' },
  { id: 'aider', label: 'aider', cost: 'subscription' },
  { id: 'lms', label: 'LM Studio', cost: 'free' },
  { id: 'llamacpp', label: 'llama.cpp', cost: 'free' },
];

/** Usage de toutes les IA détectées sur la machine — pas seulement celles déjà utilisées via CodeBreak. */
export function AllAiUsagePanel({
  det,
  cfg,
  usage,
  entries,
}: {
  det: Detection;
  cfg: Config;
  usage: ClaudeUsage | null;
  entries: LedgerEntry[];
}) {
  const byBackend = usageByBackend(entries);
  return (
    <Box flexDirection="column">
      <Text bold>{t('IA installées sur ce PC')}</Text>
      {BACKEND_DESCRIPTORS.map(({ id, label, cost }) => {
        const info = det[id];
        // décoché dans /tools = retiré de la liste (réactivable uniquement via /tools)
        if (!info.installed || !cfg[id].enabled) return null;
        const s = byBackend.get(id);
        const model = defaultModelInfo(id, cfg);
        return (
          <Box key={id} flexDirection="column">
            <Text>
              {'  '}
              <Ok ok={info.ready} /> <Text bold>{label.padEnd(16)}</Text>
              <Text color={cost === 'free' ? color.ok : cost === 'included' ? color.route : color.warn}>{cost.padEnd(13)}</Text>
              <Text color={color.dim}>{t('modèle : ')}</Text>
              <Text color={model.auto ? color.dim : color.accentStrong}>{model.value}</Text>
            </Text>
            <Text color={color.dim}>
              {'      '}
              {id === 'claude' ? (
                <QuotaLine usage={usage} cfg={cfg} compact />
              ) : s ? (
                <Text>
                  {s.runs}{t('× via CodeBreak · réussite ')}{pct(s.ok / s.runs)} · {fmtTokens(s.inputTokens + s.outputTokens)} tokens
                  {s.costUsd > 0.0005 ? ` · ${s.costUsd.toFixed(3)} $` : ''}
                </Text>
              ) : (
                <Text>{t('jamais utilisé via CodeBreak')}{info.ready ? '' : ` · ${info.detail}`}</Text>
              )}
            </Text>
          </Box>
        );
      })}
      <Text color={color.dim}>
        {'  '}{t('/models &lt;ia&gt; pour changer le modèle par défaut · /tools pour activer/désactiver · /usage jour|semaine|tout pour le détail par modèle')}</Text>
    </Box>
  );
}

export function UsagePanel({
  usage,
  cfg,
  today,
  week,
  all,
}: {
  usage: ClaudeUsage | null;
  cfg: Config;
  today: Summary;
  week: Summary;
  all: Summary;
}) {
  const block = (title: string, s: Summary) => (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {s.runs === 0 ? (
        <Text color={color.dim}>  {t('aucune exécution')}</Text>
      ) : (
        <>
          <Text color={color.dim}>
            {'  '}
            {s.tasks} {t('tâche(s) · ')}{s.runs} {t('exécution(s) · réussite ')}{pct(s.successRate)} {t('· escalades ')}{pct(s.escalationRate)}
            {s.savedUsdEstimate > 0.005 ? t(' · économie ≈ {v} $ (équiv. API Sonnet)', { v: s.savedUsdEstimate.toFixed(2) }) : ''}
          </Text>
          {s.byTarget.map((t) => (
            <Text key={t.target}>
              {'  '}
              <Text>{t.target.padEnd(42)}</Text>
              <Text color={color.dim}>
                {String(t.runs).padStart(3)}× · {pct(t.ok / t.runs).padStart(4)} · {fmtTokens(t.inputTokens + t.outputTokens).padStart(6)} tokens · ⌀ {fmtDuration(t.avgMs)}
              </Text>
            </Text>
          ))}
        </>
      )}
    </Box>
  );
  return (
    <Box flexDirection="column">
      <Text bold>{t('Quota Claude')}</Text>
      <Box paddingLeft={2} flexDirection="column">
        <QuotaLine usage={usage} cfg={cfg} compact />
        {usage?.fiveHour ? <Text color={color.dim}>{t('5h : réinitialisation ')}{fmtReset(usage.fiveHour.resetsAt)}</Text> : null}
        {usage?.sevenDay ? <Text color={color.dim}>{t('7j : réinitialisation ')}{fmtReset(usage.sevenDay.resetsAt)}</Text> : null}
        <Text color={color.dim}>
          {t('seuils : tendu ≥ ')}{pct(cfg.quota.claude.soft)} {t('· critique ≥ ')}{pct(cfg.quota.claude.hard)} {t('· coupé ≥ ')}{pct(cfg.quota.claude.stop)}
        </Text>
      </Box>
      {block(t('Aujourd’hui'), today)}
      {block(t('7 derniers jours'), week)}
      {block('Total', all)}
    </Box>
  );
}

export function HelpPanel() {
  return (
    <Box flexDirection="column">
      <Text bold>Utilisation</Text>
      <Text color={color.dim}>  {t('Tape ta demande : le routeur choisit l’outil et le modèle, puis exécute et vérifie.')}</Text>
      <Text color={color.dim}>  {t('Préfixe @opus @sonnet @haiku @local @free @copilot @gemini @vibe @aider @lms @llama pour forcer une cible.')}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{t('Commandes')}</Text>
        {COMMANDS.map((c) => (
          <Text key={c.name}>
            {'  '}
            <Text color={color.brand}>{(c.name + (c.args ? ' ' + t(c.args) : '')).padEnd(46)}</Text>
            <Text color={color.dim}>{t(c.description)}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{t('Raccourcis')}</Text>
        <Text color={color.dim}>  {t('Shift+Tab   change de profil (eco → balanced → quality)')}</Text>
        <Text color={color.dim}>  {t('Esc         interrompt l’exécution en cours')}</Text>
        <Text color={color.dim}>  {t('Molette · Page↑/↓   fait défiler l’historique · clic sur « Aller en bas » pour revenir')}</Text>
        <Text color={color.dim}>  {t('Sélection   Fn+glisser (Terminal.app) ou Option+glisser (iTerm2) · Ctrl+Y copie rapide')}</Text>
        <Text color={color.dim}>  {t('Ctrl+C      interrompt / efface / quitte (deux fois)')}</Text>
        <Text color={color.dim}>  {t('\\ + Entrée  saut de ligne (ou Ctrl+J) · ↑↓ historique · Tab complète')}</Text>
        <Text color={color.dim}>  {t('Ctrl/Option+←→   saute de mot en mot · Ctrl+A/E (ou Home/End) début/fin de ligne')}</Text>
        <Text color={color.dim}>  {t('Ctrl+W · Option+⌫  efface le mot précédent · Ctrl/Option+Suppr efface le suivant')}</Text>
        <Text color={color.dim}>  {t('Ctrl+V      colle une image du presse-papiers (macOS/Windows/Linux)')}</Text>
      </Box>
    </Box>
  );
}

export function Lines({ children }: { children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

export type { LedgerEntry };

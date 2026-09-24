import type { Config } from './config/schema.js';
import type { Detection } from './detect/types.js';
import { KIND_LABEL } from './exec/diagnose.js';
import { runTask } from './exec/runner.js';
import { prepareTask } from './memory/task.js';
import { route } from './router/index.js';
import { buildTargets, ALL_BACKENDS, resolveTarget } from './router/targets.js';
import type { ClaudeUsage, Decision } from './types.js';
import { getClaudeUsage, isFresh, loadUsage } from './usage/claude.js';
import { fmtDuration, fmtTokens } from './ui/format.js';
import { t } from './i18n/index.js';

export interface OneShotOptions {
  prompt: string;
  cwd: string;
  cfg: Config;
  det: Detection;
  force?: string;
  json?: boolean;
  /** décision seulement, sans exécuter */
  dryRun?: boolean;
  quiet?: boolean;
}

export async function freshUsage(det: Detection, cfg: Config): Promise<ClaudeUsage | null> {
  const cached = loadUsage();
  if (!det.claude.ready || isFresh(cached, cfg.quota.claude.probe_ttl_min)) return cached;
  return (await getClaudeUsage(det.claude.path, cfg)) ?? cached;
}

export function describeDecision(d: Decision): string {
  const f = d.features;
  const lines = [
    t('→ {v}  (complexité {complexity}/5 · {category}{v2}{v3})', { v: d.primary ? d.primary.label : t('aucune cible'), complexity: f.complexity, category: f.category, v2: f.security ? t(' · sécurité') : '', v3: f.needsMcp ? ' · MCP' : '' }),
    ...d.reasons.map((r) => `   · ${r}`),
    d.chain.length > 1 ? t('   · escalade : {v}', { v: d.chain.map((t) => t.label).join(' → ') }) : '',
    t('   · classifieur : {v}', { v: d.classifierModel ? `${d.classifierModel} (${fmtDuration(d.classifierMs ?? 0)})` : t('règles (confiance {confidence})', { confidence: f.confidence }) }),
    ...d.warnings.map((w) => `   ⚠ ${w}`),
  ];
  return lines.filter(Boolean).join('\n');
}

export async function runOneShot(o: OneShotOptions): Promise<number> {
  const usage = await freshUsage(o.det, o.cfg);
  const forcedTarget = o.force ? resolveTarget(o.force, buildTargets(o.det, o.cfg)) : undefined;
  if (o.force && !forcedTarget) {
    const disabled = ALL_BACKENDS.filter((b) => !o.cfg[b.id].enabled).map((b) => b.id);
    console.error(t('Cible inconnue ou désactivée : {force}{v}', { force: o.force, v: disabled.length ? t(' (désactivés : {v} — codebreak tools on <outil>)', { v: disabled.join(', ') }) : '' }));
    return 2;
  }
  const { prompt, decision } = await route(o.prompt, { cwd: o.cwd, cfg: o.cfg, det: o.det, usage, forcedTarget });

  if (o.dryRun) {
    if (o.json) {
      console.log(
        JSON.stringify({
          primary: decision.primary?.id ?? null,
          chain: decision.chain.map((t) => t.id),
          features: decision.features,
          requiredLevel: decision.requiredLevel,
          quota: decision.quota,
          reasons: decision.reasons,
          warnings: decision.warnings,
          classifier: decision.classifierModel ?? 'rules',
        }),
      );
    } else console.log(describeDecision(decision));
    return decision.primary ? 0 : 1;
  }

  if (!o.quiet) console.error(describeDecision(decision));
  if (!decision.primary) return 1;

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const t0 = Date.now();
  let tokens = 0;
  let ok = false;
  const chunks: string[] = [];
  const prepared = prepareTask(o.cwd, o.cfg, decision, prompt);
  for await (const ev of runTask({ prompt, decision, cwd: o.cwd, cfg: o.cfg, det: o.det, signal: ac.signal, contextText: prepared.context.text, recorder: prepared.recorder, taskId: prepared.taskId })) {
    if (ev.type === 'attempt' && ev.n > 1) console.error(t('\n⤴ tentative {n}/{total} : {label}', { n: ev.n, total: ev.total, label: ev.target.label }));
    else if (ev.type === 'diagnosis' && !o.quiet) console.error(t('Diagnostic (tentative {n}) : {kind} — {summary}', { n: ev.attempt, kind: t(KIND_LABEL[ev.diagnosis.kind]), summary: ev.diagnosis.summary }));
    else if (ev.type === 'retry') console.error(t('↻ Nouvelle tentative avec {label} — {reason}', { label: ev.target.label, reason: ev.reason }));
    else if (ev.type === 'rollback' && !o.quiet) console.error(t('↩ Tentative {n} annulée : {restored} fichier(s) restauré(s), {removed} supprimé(s), {skipped} laissé(s) (modifiés depuis)', { n: ev.attempt, restored: ev.restored.length, removed: ev.removed.length, skipped: ev.skipped }));
    else if (ev.type === 'escalate') console.error(t('⤴ escalade {label} → {label2} ({reason})', { label: ev.from.label, label2: ev.to.label, reason: ev.reason }));
    else if (ev.type === 'verify_result') {
      for (const s of ev.result.steps) console.error(`${s.ok ? '✔' : '✘'} ${s.command} (${fmtDuration(s.ms)})`);
    } else if (ev.type === 'run') {
      const e = ev.event;
      if (e.type === 'text') {
        chunks.push(e.text);
        if (!o.json) process.stdout.write(e.delta ? e.text : e.text + '\n');
      } else if (e.type === 'reasoning') {
        if (!o.json && !o.quiet) process.stderr.write(`\x1b[2m💭 ${e.text}\x1b[0m\n`);
      } else if (e.type === 'tool' && !o.quiet) console.error(`⏺ ${e.name}(${e.summary})`);
      else if (e.type === 'usage') tokens += e.inputTokens + e.outputTokens;
      else if (e.type === 'error') console.error(`✘ ${ev.target.label} : ${e.message}`);
      else if (e.type === 'handoff') console.error(e.message);
    } else if (ev.type === 'done') {
      ok = ev.ok;
      if (o.json) console.log(JSON.stringify({ ok: ev.ok, target: ev.target?.id, text: ev.text, verified: ev.verified, message: ev.message }));
      if (!o.quiet) {
        console.error(`\n${ev.ok ? '✔' : '✘'} ${ev.target?.label ?? '—'} · ${fmtDuration(Date.now() - t0)}${tokens ? ` · ${fmtTokens(tokens)} tokens` : ''}${ev.verified ? t(' · vérifié') : ''}${ev.message ? ` · ${ev.message}` : ''}`);
      }
    }
  }
  return ok ? 0 : 1;
}

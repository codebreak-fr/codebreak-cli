import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { Decision } from '../types.js';
import { buildContext, type ContextPack } from './context-builder.js';
import { TaskRecorder } from './recorder.js';

export interface PreparedTask {
  taskId: string;
  recorder: TaskRecorder | null;
  context: ContextPack;
}

/**
 * Prépare une tâche : identifiant, contexte sélectionné pour la demande et enregistreur de mémoire Markdown.
 * Sans effet de bord si la mémoire est désactivée (`recorder` = null, contexte vide).
 */
export function prepareTask(cwd: string, cfg: Config, decision: Decision, prompt: string): PreparedTask {
  const taskId = randomUUID().slice(0, 8);
  const context = buildContext(cwd, cfg, prompt);
  const recorder = TaskRecorder.create({ cwd, cfg, id: taskId, prompt, escalation: decision.chain.map((t) => t.id) });
  recorder?.contextUsed(context.counts);
  return { taskId, recorder, context };
}

import { Box, Text } from 'ink';
import { t } from '../i18n/index.js';
import type { ContextItem, ContextKind, ContextPack, ReasonCode } from '../memory/context-builder.js';
import { color } from './theme.js';

export const KIND_LABEL: Record<ContextKind, string> = {
  goal: 'Objectif',
  constraints: 'Contraintes',
  commands: 'Commandes du projet',
  state: 'État courant',
  verification: 'Dernière vérification',
  decision: 'Décision',
  failure: 'Échec précédent',
  architecture: 'Architecture',
  files: 'Fichiers probables',
};

/** Raison d'inclusion/exclusion dans la langue courante. */
export function reasonText(r: ContextItem['reason'], score: number): string {
  const terms = (r.terms ?? []).slice(0, 5).join(', ');
  const files = (r.files ?? []).slice(0, 3).join(', ');
  const by: Record<ReasonCode, () => string> = {
    always: () => t('contexte permanent du projet'),
    pinned: () => t('épinglé'),
    relevant: () => t('pertinent : {terms} (score {score})', { terms, score }),
    file_match: () => t('cite {files} (score {score})', { files, score }),
    similar_failure: () => t('une tâche similaire a déjà échoué'),
    latest: () => t('dernier état connu'),
    below_threshold: () => t('pas assez pertinent (score {score})', { score }),
    over_budget: () => t('au-delà du budget de contexte'),
    placeholder: () => t('modèle vide, rien à envoyer'),
    cap: () => t('au-delà de la limite pour ce type d’entrée'),
  };
  return by[r.code]();
}

/** `/context why` : ce qui serait envoyé à un agent pour cette demande, et pourquoi. */
export function ContextPanel({ pack, task }: { pack: ContextPack; task: string }) {
  const inc = pack.items.filter((i) => i.included);
  const exc = pack.items.filter((i) => !i.included);
  return (
    <Box flexDirection="column">
      <Text bold>{t('Contexte sélectionné pour : {task}', { task: task.slice(0, 80) })}</Text>
      <Text color={color.dim}>
        {'  '}{t('{used}/{budget} caractères · {decisions} décision(s) · {failures} échec(s) précédent(s) · {files} fichier(s)', { used: pack.usedChars, budget: pack.budget, decisions: pack.counts.decisions, failures: pack.counts.failures, files: pack.counts.files })}
      </Text>
      {inc.map((i, n) => (
        <Text key={`i${n}`} wrap="truncate-end">
          {'  '}<Text color={color.ok}>✓</Text> {t(KIND_LABEL[i.kind])} · {i.heading} <Text color={color.dim}>[{i.source}] {reasonText(i.reason, i.score)}</Text>
        </Text>
      ))}
      {exc.map((i, n) => (
        <Text key={`e${n}`} color={color.dim} wrap="truncate-end">
          {'  '}✗ {t(KIND_LABEL[i.kind])} · {i.heading} [{i.source}] {reasonText(i.reason, i.score)}
        </Text>
      ))}
      {!pack.items.length ? <Text color={color.dim}>{'  '}{t('Aucune mémoire de projet (.codebreak/) pour l’instant : elle se remplit au fil des tâches.')}</Text> : null}
    </Box>
  );
}

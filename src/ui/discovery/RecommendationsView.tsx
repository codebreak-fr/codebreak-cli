import { Box, Text } from 'ink';
import { CATEGORY_BY_ID, categoryLabel } from '../../catalog/categories.js';
import { describeMachine, summarizeModel, VERDICT_ICON } from '../../catalog/present.js';
import type { CategoryResult } from '../../catalog/types.js';
import type { Config } from '../../config/schema.js';
import type { Detection } from '../../detect/types.js';
import { color } from '../theme.js';
import { describeExcluded } from './ModelList.js';
import { t } from '../../i18n/index.js';

/** Sortie texte non interactive de `cb models recommend` (mêmes libellés que la TUI). */
export function RecommendationsView({ det, cfg, results }: { det: Detection; cfg: Config; results: CategoryResult[] }) {
  const m = describeMachine(det.hardware, cfg);
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{m.title}</Text> <Text color={color.dim}>· {m.memory} · {m.backend} · {m.budget}</Text>
      </Text>
      {results.map((r) => {
        const recs = [...r.recommended, ...(r.slow ? [r.slow] : [])];
        const def = CATEGORY_BY_ID[r.category];
        return (
          <Box key={r.category} flexDirection="column" marginTop={1}>
            <Text bold>
              {def.icon} {categoryLabel(r.category)} <Text color={color.dim}>({r.category})</Text>
            </Text>
            {recs.length ? (
              recs.map((x) => (
                <Text key={x.model.id}>
                  {'  '}
                  {VERDICT_ICON[x.verdict]} {x.model.name}
                  {x.installed ? <Text color={color.ok}> {t('✔ installé')}</Text> : null}
                  {'\n'}
                  <Text color={color.dim}>{'     '}{summarizeModel(x)}</Text>
                </Text>
              ))
            ) : (
              <Text color={color.dim}>{'  '}{t('aucun modèle adapté — ')}{describeExcluded(r)}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

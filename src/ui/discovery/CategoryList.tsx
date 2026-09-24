import { Box, Text, useInput } from 'ink';
import { CATEGORIES, categoryDescription, categoryLabel } from '../../catalog/categories.js';
import type { CategoryId, CategoryResult } from '../../catalog/types.js';
import { ListRow, useListNav } from '../kit/index.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

export type CategoryChoice = CategoryId | 'installed';

/** Liste des catégories (+ modèles installés), avec le nombre de modèles adaptés à la machine. */
export function CategoryList({
  results,
  installed,
  installedCount,
  initial,
  onSelect,
  onRefresh,
}: {
  results: Record<CategoryId, CategoryResult>;
  /** modèles déjà installés par catégorie */
  installed: Partial<Record<CategoryId, number>>;
  installedCount: number;
  initial?: CategoryChoice;
  onSelect: (c: CategoryChoice) => void;
  onRefresh: () => void;
}) {
  const rows: { id: CategoryChoice; icon: string; label: string; hint: string; empty: boolean }[] = [
    ...CATEGORIES.map((c) => {
      const r = results[c.id];
      const n = r.recommended.length + (r.slow ? 1 : 0);
      const have = installed[c.id] ?? 0;
      const hint = [n ? t('{n} modèle{v}', { n, v: n > 1 ? 's' : '' }) : t('aucun modèle adapté'), have ? t('{have} installé{v}', { have, v: have > 1 ? 's' : '' }) : ''].filter(Boolean).join(' · ');
      return { id: c.id as CategoryChoice, icon: c.icon, label: categoryLabel(c.id), hint, empty: n === 0 && have === 0 };
    }),
    { id: 'installed', icon: '📦', label: t('Modèles installés'), hint: `${installedCount}`, empty: false },
  ];
  const [sel] = useListNav(rows.length, Math.max(0, rows.findIndex((r) => r.id === initial)));
  useInput((input, key) => {
    if (key.return) onSelect(rows[sel]!.id);
    else if (input === 'r') onRefresh();
  });
  return (
    <>
      {rows.map((r, i) => (
        <ListRow key={r.id} selected={i === sel} dim={r.empty}>
          {r.icon} {r.label.padEnd(24)}
          <Text color={color.dim}>{r.hint}</Text>
        </ListRow>
      ))}
      <Box marginTop={1}>
        <Text color={color.dim} wrap="truncate-end">
          {rows[sel]!.id === 'installed' ? t('Tout ce qui est installé sur cette machine : Ollama, Hugging Face, MacWhisper, LM Studio…') : categoryDescription(rows[sel]!.id as CategoryId)}
        </Text>
      </Box>
    </>
  );
}

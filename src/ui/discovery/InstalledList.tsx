import { Text, useInput } from 'ink';
import { categoryLabel } from '../../catalog/categories.js';
import { fmtGB } from '../../catalog/present.js';
import type { InstalledModel } from '../../catalog/installer.js';
import { ListRow, useListNav } from '../kit/index.js';
import { color } from '../theme.js';
import { t } from '../../i18n/index.js';

/** Modèles présents sur la machine (Ollama + cache Hugging Face) ; Entrée ou x pour en supprimer un. */
export function InstalledList({ items, onRemove }: { items: InstalledModel[]; onRemove: (m: InstalledModel) => void }) {
  const [sel] = useListNav(items.length);
  useInput((input, key) => {
    if ((key.return || input === 'x' || key.delete) && items[sel]) onRemove(items[sel]!);
  });
  if (!items.length) return <Text color={color.dim}>{t('Aucun modèle installé (Ollama, Hugging Face, MacWhisper, LM Studio, oMLX).')}</Text>;
  return (
    <>
      {items.map((m, i) => (
        <ListRow key={`${m.runtime}:${m.name}`} selected={i === sel}>
          📦 {m.name}
          <Text color={color.dim}>  {m.store} · {fmtGB(m.sizeGB)}{m.category ? ` · ${categoryLabel(m.category)}` : ''}</Text>
        </ListRow>
      ))}
    </>
  );
}

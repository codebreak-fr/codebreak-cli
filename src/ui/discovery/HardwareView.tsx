import { Text } from 'ink';
import { t } from '../../i18n/index.js';
import type { Config } from '../../config/schema.js';
import type { Detection } from '../../detect/types.js';
import { describeMachine } from '../../catalog/present.js';
import { Field, Ok } from '../kit/index.js';
import { color } from '../theme.js';

/** Profil de la machine détectée (source : `cb detect`) et runtimes disponibles. */
export function HardwareView({ det, cfg }: { det: Detection; cfg: Config }) {
  const m = describeMachine(det.hardware, cfg);
  const runtimes: [string, boolean][] = [
    ['Ollama', det.ollama.installed],
    ['LM Studio', det.lms.installed],
    ['llama.cpp', det.llamacpp.installed],
    ['hf', det.huggingface.installed],
  ];
  return (
    <>
      <Field label="Machine">
        <Text wrap="truncate-end">
          <Text bold>{m.title}</Text> <Text color={color.dim}>· {m.memory} · {m.backend}</Text>
        </Text>
      </Field>
      <Field label="Budget">
        <Text color={color.dim}>{m.budget}</Text>
      </Field>
      <Field label="Runtimes">
        <Text wrap="truncate-end">
          {runtimes.map(([name, ok], i) => (
            <Text key={name}>
              {i > 0 ? '  ' : ''}
              {name} <Ok ok={ok} />
            </Text>
          ))}
        </Text>
      </Field>
      {det.inventory.apps.length ? (
        <Field label={t('Apps IA')}>
          <Text color={color.dim} wrap="truncate-end">{det.inventory.apps.map((a) => a.name).join(', ')}</Text>
        </Field>
      ) : null}
    </>
  );
}

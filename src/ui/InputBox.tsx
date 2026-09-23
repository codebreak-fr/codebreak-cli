import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { useMemo, useRef, useState } from 'react';
import { isMouseInput } from './mouse.js';
import { attachmentsDir, clipboardHasImage, saveClipboardImage } from '../util/clipboard.js';
import { matchCommands, type CommandDef } from './commands.js';
import { color } from './theme.js';
import { t } from '../i18n/index.js';

export interface AliasHint {
  name: string;
  hint: string;
}

interface Props {
  disabled: boolean;
  placeholder: string;
  history: string[];
  aliases: AliasHint[];
  width: number;
  onSubmit: (text: string) => void;
  onNotice?: (text: string) => void;
}

interface Suggestion {
  name: string;
  hint: string;
  submitNow: boolean;
}

const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const stripTerminal = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

/** Comme Claude Code : un gros collage est replié en place pour ne pas envahir la saisie. */
export const PASTE_CHARS = 800;
export const PASTE_LINES = 3;
/** Repère d'un collage replié ; accepte les deux langues (le repli peut dater d'avant un changement de langue). */
export const PASTE_RE = /\[(?:Texte collé|Pasted text) #(\d+) \+\d+ (?:lignes|lines)\]/g;

/** Seuil de repli : >800 caractères ou trop de lignes pour la hauteur de la fenêtre. */
const SUGGESTION_ROWS = 8;

export function isLongPaste(text: string, rows = 40): boolean {
  const lineLimit = rows >= 12 ? PASTE_LINES : rows >= 10 ? 2 : 1;
  return text.length > PASTE_CHARS || text.split('\n').length > lineLimit;
}

/** Remplace les placeholders de collage replié par leur contenu complet. */
export function expandPastes(text: string, pastes: Map<number, string>): string {
  return text.replace(PASTE_RE, (marker, id) => pastes.get(Number(id)) ?? marker);
}

/** Index du début du mot précédent (saut de mot façon Ctrl/Option+←). */
export function wordLeft(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  return i;
}

/** Index de fin du mot suivant (saut de mot façon Ctrl/Option+→). */
export function wordRight(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && /\s/.test(value[i]!)) i++;
  while (i < value.length && !/\s/.test(value[i]!)) i++;
  return i;
}

export function InputBox({ disabled, placeholder, history, aliases, width, onSubmit, onNotice }: Props) {
  const { rows } = useWindowSize();
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [sel, setSel] = useState(0);

  const pastes = useRef<Map<number, string>>(new Map());
  const nextPasteId = useRef(1);
  const imgId = useRef(0);

  const suggestions: Suggestion[] = useMemo(() => {
    if (value.startsWith('/') && !value.includes(' ')) {
      return matchCommands(value).map((c: CommandDef) => ({ name: c.name, hint: t(c.description), submitNow: !c.args }));
    }
    if (value.startsWith('@') && !value.includes(' ')) {
      return aliases.filter((a) => a.name.startsWith(value.toLowerCase())).map((a) => ({ ...a, submitNow: false }));
    }
    return [];
  }, [value, aliases]);
  const selIdx = Math.min(sel, Math.max(0, suggestions.length - 1));
  // fenêtre défilante : la sélection reste toujours visible (la liste peut dépasser SUGGESTION_ROWS lignes)
  const windowRef = useRef(0);
  if (selIdx < windowRef.current) windowRef.current = selIdx;
  else if (selIdx >= windowRef.current + SUGGESTION_ROWS) windowRef.current = selIdx - SUGGESTION_ROWS + 1;
  windowRef.current = Math.max(0, Math.min(windowRef.current, suggestions.length - SUGGESTION_ROWS));
  const windowStart = windowRef.current;

  const set = (v: string, c = v.length) => {
    setValue(v);
    setCursor(c);
    setSel(0);
  };
  const insert = (text: string) => {
    const t = clean(text);
    if (!t) return;
    set(value.slice(0, cursor) + t + value.slice(cursor), cursor + t.length);
    setHistIdx(-1);
  };

  /** Replie un collage trop long en placeholder, comme Claude Code — le contenu complet est conservé. */
  const insertCollapsed = (raw: string) => {
    const text = clean(raw);
    if (!text) return;
    const id = nextPasteId.current++;
    pastes.current.set(id, text);
    if (pastes.current.size > 30) {
      const oldest = pastes.current.keys().next().value as number | undefined;
      if (oldest !== undefined) pastes.current.delete(oldest);
    }
    const lines = text.split('\n').length;
    const marker = t('[Texte collé #{id} +{v} lignes]', { id, v: Math.max(0, lines - 1) });
    insert(marker);
  };

  /** Remplace les placeholders de collage replié par leur contenu complet. */
  const expand = (text: string) => expandPastes(text, pastes.current);

  /**
   * Ctrl+V, ou Cmd+V quand le terminal envoie un collage vide (presse-papiers sans texte) :
   * si le presse-papiers contient une image, on la joint comme Claude Code.
   */
  const handleImagePaste = async (explicit: boolean) => {
    if (disabled) return;
    if (!(await clipboardHasImage())) {
      if (explicit) onNotice?.(t('Presse-papiers : aucune image à coller.'));
      return;
    }
    const path = await saveClipboardImage(attachmentsDir());
    if (!path) {
      onNotice?.(t('Presse-papiers : image non lisible. Captures acceptées en PNG/JPEG.'));
      return;
    }
    imgId.current += 1;
    insert(`[Image #${imgId.current}] ${path}`);
    onNotice?.(t('📸 Image collée → {path}', { path }));
  };

  usePaste(
    (raw) => {
      const t = clean(stripTerminal(raw));
      if (!t) {
        void handleImagePaste(false);
        return;
      }
      if (isLongPaste(t, rows)) insertCollapsed(t);
      else insert(t);
    },
    { isActive: !disabled },
  );

  useInput(
    (input, key) => {
      if (isMouseInput(input)) return; // molette/clics : gérés par l'application
      if (key.ctrl && input === 'c') return; // géré par l'application
      if (key.shift && key.tab) return; // idem (changement de profil)
      if (key.escape) return set('');
      if (key.ctrl && input === 'v') {
        void handleImagePaste(true);
        return;
      }

      if (key.return) {
        if (key.meta || (value.endsWith('\\') && !key.shift)) {
          const base = value.endsWith('\\') ? value.slice(0, -1) : value;
          return set(base + '\n', base.length + 1);
        }
        const pick = suggestions[selIdx];
        if (pick && value.trim() !== pick.name) {
          if (pick.submitNow) {
            onSubmit(pick.name);
            return set('');
          }
          return set(pick.name + ' ');
        }
        const text = value.trim();
        if (!text) return;
        onSubmit(expand(text));
        setHistIdx(-1);
        return set('');
      }
      if (key.tab) {
        const pick = suggestions[selIdx];
        if (pick) set(pick.name + (pick.submitNow ? '' : ' '));
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (suggestions.length > 1) {
          setSel((s) => (s + (key.upArrow ? suggestions.length - 1 : 1)) % suggestions.length);
          return;
        }
        if (history.length === 0) return;
        const next = key.upArrow ? Math.min(histIdx + 1, history.length - 1) : histIdx - 1;
        setHistIdx(next);
        const v = next < 0 ? '' : history[history.length - 1 - next]!;
        setValue(v);
        setCursor(v.length);
        return;
      }
      // saut de mot : Ctrl+←/→ (Linux/Windows/iTerm), Option+←/→ (macOS, en séquence flèche ou en Esc+b/f
      // selon le terminal) — Cmd+←/→ n'atteint jamais le processus, capté par l'app terminal elle-même.
      if ((key.ctrl || key.meta) && key.leftArrow) return setCursor(wordLeft(value, cursor));
      if ((key.ctrl || key.meta) && key.rightArrow) return setCursor(wordRight(value, cursor));
      if (key.meta && input === 'b') return setCursor(wordLeft(value, cursor));
      if (key.meta && input === 'f') return setCursor(wordRight(value, cursor));
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === 'a')) return setCursor(0);
      if (key.end || (key.ctrl && input === 'e')) return setCursor(value.length);
      if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
      if (key.ctrl && input === 'k') return set(value.slice(0, cursor), cursor);
      if (key.ctrl && input === 'j') return insert('\n');
      if ((key.ctrl && input === 'w') || (key.meta && key.backspace)) {
        const start = wordLeft(value, cursor);
        return set(value.slice(0, start) + value.slice(cursor), start);
      }
      if ((key.ctrl || key.meta) && key.delete) {
        const end = wordRight(value, cursor);
        return set(value.slice(0, cursor) + value.slice(end), cursor);
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.ctrl || key.meta || !input) return;
      insert(input);
    },
    { isActive: !disabled },
  );

  const before = value.slice(0, cursor);
  const cur = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={disabled ? color.dim : color.brand} paddingX={1} width={Math.max(20, width)}>
        <Text color={disabled ? color.dim : color.accentStrong}>{'> '}</Text>
        {value.length === 0 ? (
          <Text color={color.dim}>
            {disabled ? placeholder : <Text inverse> </Text>}
            {disabled ? '' : placeholder}
          </Text>
        ) : (
          <Text>
            {before}
            {disabled ? cur : <Text inverse>{cur === '\n' ? ' ' : cur}</Text>}
            {cur === '\n' ? '\n' : ''}
            {after}
          </Text>
        )}
      </Box>
      {suggestions.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {windowStart > 0 ? <Text color={color.dim}>↑ {windowStart} {t('de plus')}</Text> : null}
          {suggestions.slice(windowStart, windowStart + SUGGESTION_ROWS).map((s, i) => (
            <Text key={s.name} color={windowStart + i === selIdx ? color.accentStrong : color.dim}>
              {s.name.padEnd(12)} {s.hint}
            </Text>
          ))}
          {windowStart + SUGGESTION_ROWS < suggestions.length ? <Text color={color.dim}>↓ {suggestions.length - windowStart - SUGGESTION_ROWS} {t('de plus')}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
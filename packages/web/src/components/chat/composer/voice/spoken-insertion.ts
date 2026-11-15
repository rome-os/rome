import type { BehaviorContext } from "./behavior";

const HAN = /\p{Script=Han}/u;

/**
 * Whether a space belongs between `left` and `right`, as a guardian typing
 * would add one: before a word, after anything but a space. Chinese takes none.
 */
function needsSpace(left: string, right: string): boolean {
  if (!left || /\s/.test(left) || HAN.test(left) || HAN.test(right)) return false;
  return /[\p{L}\p{N}]/u.test(right);
}

/**
 * The spoken text as it lands between `before` and `after`: a space separates
 * it from a word right before or right after the cursor. Chinese takes none.
 */
export function spokenInsertion(before: string, heard: string, after = ""): string {
  const text = heard.trim();
  if (!text) return "";
  const lead = needsSpace(before.slice(-1), text[0]) ? " " : "";
  const trail = needsSpace(text.slice(-1), after[0] ?? "") ? " " : "";
  return lead + text + trail;
}

/** The message field, as spoken insertion reaches it. */
export interface TextEditor {
  /** The field's text, and its selection or the end of the text when the field is gone. */
  read(): { value: string; start: number; end: number };
  /** Shows `value` in the field before returning. Not an edit: no undo step and no change event. */
  write(value: string): void;
  /** Focuses the field and selects `start` to `end`. False when the field could not take focus. */
  select(start: number, end: number): boolean;
  /** Inserts `text` at the focused selection as typing does: one undo step and one input event. */
  insert(text: string): boolean;
  /** Calls `shown` once, when a hidden field shows again. Returns the cleanup. */
  whenShown(shown: () => void): () => void;
}

interface Anchor {
  /** The field as it was when listening started. */
  original: string;
  before: string;
  after: string;
  start: number;
  end: number;
}

/**
 * Shows the heard text at the cursor, then inserts it as one undoable edit.
 * `begin` marks the cursor, `preview` shows what was heard so far, and
 * `commit` puts the field back as it was and inserts the text the way typing
 * does, so one undo removes it and the field's change handler sees typed text.
 */
export function createSpokenInsertion<State>(
  context: BehaviorContext<State>,
  options: { editor: TextEditor },
) {
  const { editor } = options;
  let anchor: Anchor | null = null;
  let inserting = false;
  let stopWaiting: (() => void) | null = null;

  const cancelWait = () => {
    stopWaiting?.();
    stopWaiting = null;
  };
  context.onDestroy(cancelWait);

  const typeAt = (at: Anchor, text: string) => {
    if (!editor.select(at.start, at.end)) return false;
    inserting = true;
    try {
      return editor.insert(text);
    } finally {
      inserting = false;
    }
  };

  return {
    /** True while the spoken text goes in, so its input event is not read as the guardian's edit. */
    isInserting: () => inserting,
    begin() {
      cancelWait();
      const { value, start, end } = editor.read();
      anchor = {
        original: value,
        before: value.slice(0, start),
        after: value.slice(end),
        start,
        end,
      };
    },
    preview(heard: string) {
      if (!anchor) return;
      editor.write(
        anchor.before + spokenInsertion(anchor.before, heard, anchor.after) + anchor.after,
      );
    },
    commit(heard: string) {
      const at = anchor;
      anchor = null;
      if (!at) return;
      const text = spokenInsertion(at.before, heard, at.after);
      // Back to the field and selection as they were, so the spoken text
      // replaces the selection the way typing would, and undo brings it back.
      editor.write(at.original);
      if (!text) {
        editor.select(at.start, at.end);
        return;
      }
      if (typeAt(at, text)) return;
      // A hidden field cannot take focus, as when share mode or a card hides
      // the composer. The draft keeps the text meanwhile, and once the field
      // shows the text goes in again natively, so one undo still removes it.
      const spoken = at.before + text + at.after;
      editor.write(spoken);
      stopWaiting = editor.whenShown(() => {
        stopWaiting = null;
        // The guardian changed the field first: their edit stands.
        if (editor.read().value !== spoken) return;
        editor.write(at.original);
        if (!typeAt(at, text)) editor.write(spoken);
      });
    },
  };
}

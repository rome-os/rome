// Dictation into a message field, with no React: the field, the transcriber,
// the draft and the page arrive as ports.

import type {
  Dictation,
  DictationHandlers,
  DictationStop,
  DictationStopReason,
} from "@/lib/voice-input/dictation";
import { spokenInsertion } from "./spoken-insertion";

export type VoiceInputState = "idle" | "listening" | "finishing";

/** What the voice control and the field render from. */
export interface VoiceInputView {
  phase: VoiceInputState;
  /** True while the browser asks the guardian for the microphone. */
  asking: boolean;
}

/** The message field. */
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

/** Starts one dictation, as `startDictation` does. */
export type Transcriber = (handlers: DictationHandlers) => Dictation;

/** The field's draft, which owns the notice so that it outlives the field. */
export interface NoticeDraft {
  set(stop: DictationStop | null): void;
  /** Saves `stop` with the draft's latest text at once, for a field that is going away. */
  keep(stop: DictationStop): void;
}

/** The page the field is on. */
export interface PageEvents {
  /** Calls `hidden` each time the page goes away: a reload, a close, or a move into the back/forward cache. Returns the cleanup. */
  onHide(hidden: () => void): () => void;
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
 * While listening, the heard text shows at the cursor. When listening ends,
 * the field goes back as it was and the text goes in the way typing inserts
 * it, as one edit, so one undo removes it. Why listening stopped on its own
 * is the notice, kept in the draft until the next edit or send.
 *
 * Every way listening ends goes through one exit, which puts the phase back
 * to idle. Leaving the page or the chat is one of them, and leaves the heard
 * words where the preview put them instead of touching the field.
 */
export function createVoiceInput(ports: {
  editor: TextEditor;
  transcriber: Transcriber;
  draft: NoticeDraft;
  page: PageEvents;
}) {
  const { editor, draft } = ports;
  let view: VoiceInputView = { phase: "idle", asking: false };
  const listeners = new Set<() => void>();
  let dictation: Dictation | null = null;
  let heardSoFar = "";
  let anchor: Anchor | null = null;
  // True while the spoken text goes in, so its input event is not read as the guardian's edit.
  let inserting = false;
  let stopWaiting: (() => void) | null = null;

  const update = (next: Partial<VoiceInputView>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };

  const cancelWait = () => {
    stopWaiting?.();
    stopWaiting = null;
  };

  const typeAt = (at: Anchor, text: string) => {
    if (!editor.select(at.start, at.end)) return false;
    inserting = true;
    try {
      return editor.insert(text);
    } finally {
      inserting = false;
    }
  };

  const commit = (at: Anchor, heard: string) => {
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
  };

  /** The one exit. `leaving` is true when the field is going away with the page or the chat. */
  const finish = (heard: string, stop: DictationStop | null, leaving: boolean) => {
    const at = anchor;
    dictation = null;
    anchor = null;
    // The phase is idle before the text goes in, so the field is no longer read-only.
    update({ phase: "idle", asking: false });
    if (leaving && stop) {
      // The preview already put the heard words in the draft.
      draft.set(stop);
      draft.keep(stop);
      return;
    }
    if (at) commit(at, heard);
    draft.set(stop);
  };

  const leave = (reason: DictationStopReason) => {
    if (!dictation) return;
    dictation.cancel();
    finish(heardSoFar, { reason }, true);
  };

  const stop = () => {
    if (!dictation) return;
    update({ phase: "finishing" });
    dictation.stop();
  };

  const stopWatchingPage = ports.page.onHide(() => leave("page-reloaded"));

  return {
    view: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (dictation) return;
      cancelWait();
      const { value, start, end } = editor.read();
      anchor = {
        original: value,
        before: value.slice(0, start),
        after: value.slice(end),
        start,
        end,
      };
      heardSoFar = "";
      draft.set(null);
      update({ phase: "listening" });
      let done = false;
      const started = ports.transcriber({
        onText: (heard) => {
          heardSoFar = heard;
          if (anchor) {
            const { before, after } = anchor;
            editor.write(before + spokenInsertion(before, heard, after) + after);
          }
        },
        onAsking: (asking) => update({ asking }),
        onDone: (heard, why) => {
          done = true;
          finish(heard, why, false);
        },
      });
      if (!done) dictation = started;
    },
    /** Stops listening as the stop control does, and waits for the rest of the text. Does nothing while idle. */
    stop,
    /** Call with whether the field shows. A hidden field stops listening as the stop control does. */
    shown(visible: boolean) {
      if (!visible) stop();
    },
    /** Clears the notice, as a send does. */
    dismissNotice: () => draft.set(null),
    /** Call from the field's change handler: the guardian's edit clears the notice. */
    noticeEdited() {
      if (!inserting) draft.set(null);
    },
    /** The field is going away with its chat. */
    destroy() {
      // Leave first, while the page listener and the draft still work, then
      // drop what is still watching.
      leave("left-chat");
      stopWatchingPage();
      cancelWait();
      listeners.clear();
    },
  };
}

export type VoiceInput = ReturnType<typeof createVoiceInput>;

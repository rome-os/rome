import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";
import { shellAllowsMicrophone } from "@/lib/electron-shell";
import {
  type Dictation,
  type DictationDeps,
  type DictationStop,
  startDictation,
} from "@/lib/voice-input/dictation";

export type VoiceInputState = "idle" | "listening" | "finishing";

interface Anchor {
  /** The field as it was when listening started. */
  original: string;
  before: string;
  after: string;
  start: number;
  end: number;
}

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

/**
 * Inserts `text` at `el`'s selection the way typing does: the browser fires
 * the input event and records one undo step. The browser inserts into the
 * focused element, so this does nothing unless focus reached `el`.
 */
function insertNatively(el: HTMLTextAreaElement, text: string): boolean {
  if (document.activeElement !== el || typeof document.execCommand !== "function") return false;
  inserting = true;
  try {
    return document.execCommand("insertText", false, text);
  } finally {
    inserting = false;
  }
}

// True while `insertNatively` runs, so its input event is not read as an edit.
let inserting = false;

/**
 * Dictation into a composer's textarea. While listening, the heard text shows
 * at the cursor and the field is read-only. When listening ends the text is
 * inserted the way typing inserts it, as one edit, so one undo removes it and
 * the field's change handler sees it as typed text.
 *
 * Why listening stopped on its own is the notice, which the caller keeps with
 * the field's draft. It goes away on the next edit or send. Leaving the chat
 * or the page while listening stops it, and `keepNotice` saves why at once,
 * since the field is going away.
 */
export function useVoiceInput({
  textareaRef,
  value,
  setValue,
  notice,
  setNotice,
  keepNotice,
  deps,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  notice: DictationStop | null;
  setNotice: (next: DictationStop | null) => void;
  keepNotice: (stop: DictationStop) => void;
  deps?: DictationDeps;
}) {
  const info = useVoiceInputInfo();
  const [state, setState] = useState<VoiceInputState>("idle");
  const [asking, setAsking] = useState(false);
  const anchorRef = useRef<Anchor | null>(null);
  const dictationRef = useRef<Dictation | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  // Waits for a hidden field to show again, to insert the spoken text natively.
  const waitingRef = useRef<ResizeObserver | null>(null);

  const keepNoticeRef = useRef(keepNotice);
  keepNoticeRef.current = keepNotice;
  const setNoticeRef = useRef(setNotice);
  setNoticeRef.current = setNotice;
  useEffect(() => {
    // The heard words are in the field, so the draft already holds them. A
    // page the browser keeps for Back stays mounted, so the field is given
    // back here too; on unmount these updates do nothing.
    const leave = (reason: "left-chat" | "page-reloaded") => {
      if (!dictationRef.current) return;
      dictationRef.current.cancel();
      dictationRef.current = null;
      anchorRef.current = null;
      keepNoticeRef.current({ reason });
      setState("idle");
      setNoticeRef.current({ reason });
    };
    // `persisted`: the page went into the back/forward cache, not away.
    const onPageHide = (event: PageTransitionEvent) =>
      leave(event.persisted ? "left-chat" : "page-reloaded");
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      leave("left-chat");
      waitingRef.current?.disconnect();
    };
  }, []);

  const commit = useCallback(
    (heard: string) => {
      const anchor = anchorRef.current;
      anchorRef.current = null;
      if (!anchor) return;
      const insertion = spokenInsertion(anchor.before, heard, anchor.after);
      // Back to the field and selection as they were, so the spoken text
      // replaces the selection the way typing would, and undo brings it back.
      flushSync(() => {
        setState("idle");
        setValue(anchor.original);
      });
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(anchor.start, anchor.end);
      }
      if (!insertion) return;
      if (el && insertNatively(el, insertion)) return;
      const spoken = anchor.before + insertion + anchor.after;
      setValue(spoken);
      // A hidden field cannot take focus, as when share mode or a card hides
      // the composer. The draft keeps the text meanwhile, and once the field
      // shows the text goes in again natively, so one undo still removes it.
      if (!el || typeof ResizeObserver === "undefined") return;
      const waiting = new ResizeObserver(() => {
        if (el.getClientRects().length === 0) return;
        waiting.disconnect();
        waitingRef.current = null;
        // The guardian changed the field first: their edit stands.
        if (valueRef.current !== spoken) return;
        flushSync(() => setValue(anchor.original));
        el.focus();
        el.setSelectionRange(anchor.start, anchor.end);
        if (!insertNatively(el, insertion)) setValue(spoken);
      });
      waitingRef.current = waiting;
      waiting.observe(el);
    },
    [setValue, textareaRef],
  );

  const start = useCallback(() => {
    if (dictationRef.current) return;
    waitingRef.current?.disconnect();
    waitingRef.current = null;
    const el = textareaRef.current;
    const current = valueRef.current;
    const startAt = el ? el.selectionStart : current.length;
    const endAt = el ? el.selectionEnd : current.length;
    anchorRef.current = {
      original: current,
      before: current.slice(0, startAt),
      after: current.slice(endAt),
      start: startAt,
      end: endAt,
    };
    setNotice(null);
    setState("listening");
    dictationRef.current = startDictation(
      {
        onText: (heard) => {
          const anchor = anchorRef.current;
          if (anchor)
            setValue(
              anchor.before + spokenInsertion(anchor.before, heard, anchor.after) + anchor.after,
            );
        },
        onAsking: setAsking,
        onDone: (heard, stop) => {
          dictationRef.current = null;
          setAsking(false);
          commit(heard);
          setState("idle");
          setNotice(stop);
        },
      },
      deps,
    );
  }, [commit, deps, setNotice, setValue, textareaRef]);

  const dismissNotice = useCallback(() => setNotice(null), [setNotice]);
  // Runs inside the field's React change handler, so the edit's own value
  // lands in the same render. A native listener rendered first and put the
  // old value back, dropping the typed character.
  const noticeEdited = useCallback(() => {
    if (!inserting) setNotice(null);
  }, [setNotice]);

  const stop = useCallback(() => {
    if (!dictationRef.current) return;
    setState("finishing");
    dictationRef.current.stop();
  }, []);

  // A field no one can see does not listen: a closed tab or pane hides it
  // with `display: none`, which leaves it no boxes.
  useEffect(() => {
    const el = textareaRef.current;
    if (state !== "listening" || !el || typeof ResizeObserver === "undefined") return;
    const watching = new ResizeObserver(() => {
      if (el.getClientRects().length === 0) stop();
    });
    watching.observe(el);
    return () => watching.disconnect();
  }, [state, stop, textareaRef]);

  return {
    /**
     * False hides the voice control: the instance is not signed in to Rome
     * Cloud, Rome Cloud does not allow the account, or this is a desktop app
     * too old to give the dashboard the microphone. A dictation under way
     * keeps its control, so the guardian can always stop it.
     */
    available: (Boolean(info.data?.available) && shellAllowsMicrophone()) || state !== "idle",
    state,
    /** Why listening last stopped on its own, or null. */
    notice,
    /** True while the browser asks the guardian for the microphone. */
    asking,
    /** Clears the notice, as a send does. */
    dismissNotice,
    /** Call from the field's change handler: an edit clears the notice. */
    noticeEdited,
    /** While true, the field is read-only and sending waits. */
    active: state !== "idle",
    toggle: state === "listening" ? stop : start,
    /** Stops listening as the stop control does. Does nothing while idle. */
    stop,
  };
}

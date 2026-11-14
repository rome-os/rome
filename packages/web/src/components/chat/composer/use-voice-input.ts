import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";
import { isElectronShell } from "@/lib/electron-shell";
import {
  type Dictation,
  type DictationDeps,
  type DictationStopReason,
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
 * Dictation into a composer's textarea. While listening, the heard text shows
 * at the cursor and the field is read-only. When listening ends the text is
 * inserted the way typing inserts it, as one edit, so one undo removes it and
 * the field's change handler sees it as typed text.
 */
export function useVoiceInput({
  textareaRef,
  value,
  setValue,
  deps,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  deps?: DictationDeps;
}) {
  const info = useVoiceInputInfo();
  const [state, setState] = useState<VoiceInputState>("idle");
  const [notice, setNotice] = useState<DictationStopReason | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const dictationRef = useRef<Dictation | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => () => dictationRef.current?.cancel(), []);

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
      // The browser's own insertion is what typing does: it fires the input
      // event and records one undo step. It acts on the focused element, so
      // it runs only when focus reached the field.
      if (
        el &&
        document.activeElement === el &&
        typeof document.execCommand === "function" &&
        document.execCommand("insertText", false, insertion)
      ) {
        return;
      }
      setValue(anchor.before + insertion + anchor.after);
    },
    [setValue, textareaRef],
  );

  const start = useCallback(() => {
    if (dictationRef.current) return;
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
        onDone: (heard, reason) => {
          dictationRef.current = null;
          commit(heard);
          setState("idle");
          setNotice(reason);
        },
      },
      deps,
    );
  }, [commit, deps, setValue, textareaRef]);

  const stop = useCallback(() => {
    if (!dictationRef.current) return;
    setState("finishing");
    dictationRef.current.stop();
  }, []);

  return {
    /**
     * False hides the voice control: the instance has no transcription
     * provider, or this is the desktop app, which cannot open the microphone
     * yet.
     */
    available: Boolean(info.data?.place) && !isElectronShell(),
    state,
    /** Why listening last stopped on its own, or null. */
    notice,
    /** While true, the field is read-only and sending waits. */
    active: state !== "idle",
    toggle: state === "listening" ? stop : start,
  };
}

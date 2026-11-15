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
import { IDLE, next, type VoiceEffect, type VoiceEvent } from "./voice-input-rules";

export { spokenInsertion, type VoiceInputState } from "./voice-input-rules";

/**
 * Dictation into a composer's textarea. While listening, the heard text shows
 * at the cursor and the field is read-only. When listening ends the text is
 * inserted the way typing inserts it, as one edit, so one undo removes it and
 * the field's change handler sees it as typed text.
 *
 * Why listening stopped on its own is the notice, which the caller keeps with
 * the field's draft. It goes away on the next edit or send. Leaving the chat
 * or the page while listening ends it, and `keepNotice` saves why at once,
 * since the field is going away. The order of all this is `next` in
 * `voice-input-rules.ts`; this hook only feeds it events and does its effects.
 */
export function useVoiceInput(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  notice: DictationStop | null;
  setNotice: (next: DictationStop | null) => void;
  keepNotice: (stop: DictationStop) => void;
  deps?: DictationDeps;
}) {
  const info = useVoiceInputInfo();
  const latest = useRef(props);
  latest.current = props;
  const stateRef = useRef(IDLE);
  const [view, setView] = useState({ phase: IDLE.phase, asking: IDLE.asking });
  const dictationRef = useRef<Dictation | null>(null);
  const watchRef = useRef<ResizeObserver | null>(null);

  // Effects run in order, and an effect may report an event, which runs its
  // own effects before the next one: `stateRef` is always the latest state.
  const [dispatch] = useState(() => {
    const dispatch = (event: VoiceEvent) => {
      const [state, effects] = next(stateRef.current, event);
      stateRef.current = state;
      setView((view) =>
        view.phase === state.phase && view.asking === state.asking
          ? view
          : { phase: state.phase, asking: state.asking },
      );
      for (const effect of effects) run(effect);
    };

    const run = (effect: VoiceEffect) => {
      const { textareaRef, setValue, setNotice, keepNotice, deps } = latest.current;
      const el = textareaRef.current;
      switch (effect.do) {
        case "listen":
          dictationRef.current = startDictation(
            {
              onText: (text) => dispatch({ type: "heard", text }),
              onAsking: (asking) => dispatch({ type: "asking", asking }),
              onDone: (text, stop) => {
                dictationRef.current = null;
                dispatch({ type: "done", text, stop });
              },
            },
            deps,
          );
          return;
        case "stopListening":
          dictationRef.current?.stop();
          return;
        case "cancelListening":
          dictationRef.current?.cancel();
          dictationRef.current = null;
          return;
        case "write":
          setValue(effect.value);
          return;
        case "writeNow": {
          // The field renders editable, with this value, before a native insert.
          const { phase, asking } = stateRef.current;
          flushSync(() => {
            setView({ phase, asking });
            setValue(effect.value);
          });
          return;
        }
        case "select":
          el?.focus();
          el?.setSelectionRange(effect.start, effect.end);
          return;
        case "insert": {
          el?.focus();
          el?.setSelectionRange(effect.start, effect.end);
          // The browser inserts into the focused element, fires the input event
          // and records one undo step.
          const typed =
            el !== null &&
            document.activeElement === el &&
            typeof document.execCommand === "function" &&
            document.execCommand("insertText", false, effect.text);
          dispatch({ type: typed ? "inserted" : "insertFailed" });
          return;
        }
        case "watchShown": {
          if (!el || typeof ResizeObserver === "undefined") return;
          const watch = new ResizeObserver(() => {
            if (el.getClientRects().length === 0) return;
            watch.disconnect();
            watchRef.current = null;
            dispatch({ type: "shown", value: latest.current.value });
          });
          watchRef.current = watch;
          watch.observe(el);
          return;
        }
        case "unwatchShown":
          watchRef.current?.disconnect();
          watchRef.current = null;
          return;
        case "setNotice":
          setNotice(effect.stop);
          return;
        case "keepNotice":
          keepNotice(effect.stop);
          return;
      }
    };
    return dispatch;
  });

  useEffect(() => {
    const onPageHide = () => dispatch({ type: "left", reason: "page-reloaded" });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      dispatch({ type: "left", reason: "left-chat" });
    };
  }, [dispatch]);

  const start = useCallback(() => {
    const { textareaRef, value } = latest.current;
    const el = textareaRef.current;
    dispatch({
      type: "start",
      field: {
        original: value,
        start: el ? el.selectionStart : value.length,
        end: el ? el.selectionEnd : value.length,
      },
    });
  }, [dispatch]);
  const stop = useCallback(() => dispatch({ type: "stop" }), [dispatch]);
  const dismissNotice = useCallback(() => dispatch({ type: "dismissed" }), [dispatch]);
  // Runs inside the field's React change handler, so the edit's own value
  // lands in the same render. A native listener rendered first and put the
  // old value back, dropping the typed character.
  const noticeEdited = useCallback(() => dispatch({ type: "edited" }), [dispatch]);

  return {
    /**
     * False hides the voice control: the instance is not signed in to Rome
     * Cloud, Rome Cloud does not allow the account, or this is a desktop app
     * too old to give the dashboard the microphone.
     */
    available: Boolean(info.data?.available) && shellAllowsMicrophone(),
    state: view.phase,
    /** Why listening last stopped on its own, or null. */
    notice: props.notice,
    /** True while the browser asks the guardian for the microphone. */
    asking: view.asking,
    /** Clears the notice, as a send does. */
    dismissNotice,
    /** Call from the field's change handler: an edit clears the notice. */
    noticeEdited,
    /** While true, the field is read-only and sending waits. */
    active: view.phase !== "idle",
    toggle: view.phase === "listening" ? stop : start,
    /** Stops listening as the stop control does. Does nothing while idle. */
    stop,
  };
}

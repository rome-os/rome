import { type RefObject, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";
import { shellAllowsMicrophone } from "@/lib/electron-shell";
import {
  type DictationDeps,
  type DictationStop,
  startDictation,
} from "@/lib/voice-input/dictation";
import { textareaEditor, windowPage } from "./voice/browser-ports";
import { createVoiceField, type VoiceField, type VoiceFieldState } from "./voice/voice-field";

export type { VoiceInputState } from "./voice/listening";
export { spokenInsertion } from "./voice/spoken-insertion";

/**
 * Dictation into a composer's textarea. While listening, the heard text shows
 * at the cursor and the field is read-only. When listening ends the text is
 * inserted the way typing inserts it, as one edit, so one undo removes it and
 * the field's change handler sees it as typed text.
 *
 * Why listening stopped on its own is the notice, which the caller keeps with
 * the field's draft. It goes away on the next edit or send. Leaving the chat
 * or the page while listening ends it, and `keepNotice` saves why at once,
 * since the field may be going away. `shown` false, as when a card locks the
 * field, stops listening as the stop control does.
 */
export function useVoiceInput(props: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  notice: DictationStop | null;
  setNotice: (next: DictationStop | null) => void;
  keepNotice: (stop: DictationStop) => void;
  shown?: boolean;
  deps?: DictationDeps;
}) {
  const { textareaRef, notice, shown = true } = props;
  const info = useVoiceInputInfo();
  const [store] = useState(() =>
    createStore<VoiceFieldState>(() => ({ phase: "idle", asking: false })),
  );
  const { phase, asking } = useStore(store);
  // The ports read the latest props, so the behaviors outlive each render.
  const latest = useRef(props);
  latest.current = props;
  const fieldRef = useRef<VoiceField | null>(null);

  useEffect(() => {
    const field = createVoiceField(store, {
      editor: textareaEditor(
        textareaRef,
        () => latest.current.value,
        (next) => latest.current.setValue(next),
      ),
      transcriber: (handlers) => startDictation(handlers, latest.current.deps),
      draft: {
        set: (stop) => latest.current.setNotice(stop),
        keep: (stop) => latest.current.keepNotice(stop),
      },
      page: windowPage,
    });
    fieldRef.current = field;
    return () => {
      fieldRef.current = null;
      field.destroy();
    };
  }, [store, textareaRef]);

  useEffect(() => {
    fieldRef.current?.presence.shown(shown);
  }, [shown]);

  const [api] = useState(() => ({
    start: () => fieldRef.current?.listening.start(),
    stop: () => fieldRef.current?.listening.stop(),
    dismissNotice: () => fieldRef.current?.notice.clear(),
    noticeEdited: () => fieldRef.current?.notice.edited(),
  }));

  return {
    /**
     * False hides the voice control: the instance is not signed in to Rome
     * Cloud, Rome Cloud does not allow the account, or this is a desktop app
     * too old to give the dashboard the microphone.
     */
    available: Boolean(info.data?.available) && shellAllowsMicrophone(),
    state: phase,
    /** Why listening last stopped on its own, or null. */
    notice,
    /** True while the browser asks the guardian for the microphone. */
    asking,
    /** Clears the notice, as a send does. */
    dismissNotice: api.dismissNotice,
    /** Call from the field's change handler: an edit clears the notice. */
    noticeEdited: api.noticeEdited,
    /** While true, the field is read-only and sending waits. */
    active: phase !== "idle",
    toggle: phase === "listening" ? api.stop : api.start,
    /** Stops listening as the stop control does. Does nothing while idle. */
    stop: api.stop,
  };
}

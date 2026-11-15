import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";
import { shellAllowsMicrophone } from "@/lib/electron-shell";
import {
  type DictationDeps,
  type DictationStop,
  startDictation,
} from "@/lib/voice-input/dictation";
import { textareaEditor, windowPage } from "./voice/browser-ports";
import { createVoiceInput, type VoiceInput, type VoiceInputView } from "./voice/voice-input";

export { spokenInsertion } from "./voice/spoken-insertion";
export type { VoiceInputState } from "./voice/voice-input";

const IDLE: VoiceInputView = { phase: "idle", asking: false };

/**
 * Dictation into a composer's textarea: `createVoiceInput` on the field's
 * React state. While listening the field is read-only and sending waits.
 * `notice` lives with the caller's draft, and `keepNotice` saves it at once
 * when the field goes away mid-dictation. `shown` false, as when a card locks
 * the field, stops listening as the stop control does.
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
  // The ports read the latest props, so the controller outlives each render.
  const latest = useRef(props);
  latest.current = props;
  const [voice, setVoice] = useState<VoiceInput | null>(null);

  useEffect(() => {
    const created = createVoiceInput({
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
    setVoice(created);
    return created.destroy;
  }, [textareaRef]);

  useEffect(() => {
    voice?.shown(shown);
  }, [voice, shown]);

  const { phase, asking } = useSyncExternalStore(
    voice?.subscribe ?? noSubscribe,
    voice?.view ?? idleView,
  );
  // Stable across renders, as callers list them in effect dependencies.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [api] = useState(() => ({
    start: () => voiceRef.current?.start(),
    stop: () => voiceRef.current?.stop(),
    dismissNotice: () => voiceRef.current?.dismissNotice(),
    noticeEdited: () => voiceRef.current?.noticeEdited(),
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

const noSubscribe = () => () => {};
const idleView = () => IDLE;

import type {
  Dictation,
  DictationHandlers,
  DictationStop,
  DictationStopReason,
} from "@/lib/voice-input/dictation";
import type { BehaviorContext } from "./behavior";

export type VoiceInputState = "idle" | "listening" | "finishing";

/** The store fields listening writes. No other behavior writes them. */
export interface ListeningState {
  phase: VoiceInputState;
  /** True while the browser asks the guardian for the microphone. */
  asking: boolean;
}

/** Starts one dictation, as `startDictation` does. */
export type Transcriber = (handlers: DictationHandlers) => Dictation;

/**
 * Listens until stopped, or until a stated reason ends it. Every way listening
 * ends calls `ended` once, after `phase` is back to idle: the guardian's stop
 * and the rest of the text, a reason the transcriber gave, or `end(reason)`.
 */
export function createListening<State extends ListeningState>(
  context: BehaviorContext<State>,
  options: {
    transcriber: Transcriber;
    /** Listening started. */
    started: () => void;
    /** All the text heard so far, each time it changes. */
    heard: (text: string) => void;
    /** Listening ended, with everything heard, and why when the guardian did not stop it. */
    ended: (heard: string, stop: DictationStop | null) => void;
  },
) {
  const { store } = context;
  let dictation: Dictation | null = null;
  let heardSoFar = "";

  const finish = (heard: string, stop: DictationStop | null) => {
    dictation = null;
    store.setState({ phase: "idle", asking: false } as Partial<State>);
    options.ended(heard, stop);
  };

  context.onDestroy(() => {
    dictation?.cancel();
    dictation = null;
  });

  return {
    isActive: (state: ListeningState) => state.phase !== "idle",
    start() {
      if (dictation) return;
      heardSoFar = "";
      store.setState({ phase: "listening" } as Partial<State>);
      options.started();
      let done = false;
      const started = options.transcriber({
        onText: (text) => {
          heardSoFar = text;
          options.heard(text);
        },
        onAsking: (asking) => store.setState({ asking } as Partial<State>),
        onDone: (text, stop) => {
          done = true;
          finish(text, stop);
        },
      });
      if (!done) dictation = started;
    },
    /** Stops listening and waits for the rest of the text. Does nothing while idle. */
    stop() {
      if (!dictation) return;
      store.setState({ phase: "finishing" } as Partial<State>);
      dictation.stop();
    },
    /** Ends listening at once for `reason`, with the text heard so far. Does nothing while idle. */
    end(reason: DictationStopReason) {
      const ending = dictation;
      if (!ending) return;
      ending.cancel();
      finish(heardSoFar, { reason });
    },
  };
}

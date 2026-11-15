// The sequencing of dictation into a message field, as one pure function:
// `next(state, event)` returns the next state and what to do, as data.
// `useVoiceInput` turns what happens into events and does the effects.

import type { DictationStop } from "@/lib/voice-input/dictation";

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

export type VoiceInputState = "idle" | "listening" | "finishing";

/** The field as it was when listening started. */
export interface Anchor {
  original: string;
  start: number;
  end: number;
}

/** Spoken text on its way into the field as one typed edit. */
interface Insertion {
  anchor: Anchor;
  text: string;
  /** The field with the text in it, as it stands while the edit waits. */
  spoken: string;
  /** False on the first try, true once the field showed again. */
  retry: boolean;
}

export interface VoiceState {
  phase: VoiceInputState;
  /** True while the browser asks the guardian for the microphone. */
  asking: boolean;
  /** Set while listening: where the heard text goes. */
  anchor: Anchor | null;
  /** The insert under way: its input event is not the guardian's edit. */
  inserting: Insertion | null;
  /** An insert waiting for a hidden field to show. */
  waiting: Insertion | null;
}

export const IDLE: VoiceState = {
  phase: "idle",
  asking: false,
  anchor: null,
  inserting: null,
  waiting: null,
};

export type VoiceEvent =
  /** The guardian starts listening, with the field as it is now. */
  | { type: "start"; field: Anchor }
  | { type: "heard"; text: string }
  | { type: "asking"; asking: boolean }
  /** The guardian's stop, or the field hidden behind a card. */
  | { type: "stop" }
  /** The transcriber is done: `stop` is null after the guardian's stop. */
  | { type: "done"; text: string; stop: DictationStop | null }
  | { type: "left"; reason: "left-chat" | "page-reloaded" }
  | { type: "inserted" }
  /** The field could not take focus, so the native insert did not happen. */
  | { type: "insertFailed" }
  /** A hidden field shows again, holding `value`. */
  | { type: "shown"; value: string }
  /** The field's change handler ran. */
  | { type: "edited" }
  /** A send clears the notice. */
  | { type: "dismissed" };

export type VoiceEffect =
  | { do: "listen" }
  | { do: "stopListening" }
  | { do: "cancelListening" }
  /** Shows `value` in the field. Not an edit. */
  | { do: "write"; value: string }
  /** Shows `value` in the field and renders the state with it before the next effect runs. */
  | { do: "writeNow"; value: string }
  | { do: "select"; start: number; end: number }
  /** Selects `start` to `end` and inserts `text` as typing does; reports `inserted` or `insertFailed`. */
  | { do: "insert"; start: number; end: number; text: string }
  /** Reports `shown` once the hidden field shows again. */
  | { do: "watchShown" }
  | { do: "unwatchShown" }
  | { do: "setNotice"; stop: DictationStop | null }
  /** Saves the notice with the draft at once, for a field that is going away. */
  | { do: "keepNotice"; stop: DictationStop };

type Step = [VoiceState, VoiceEffect[]];
type Rule<E extends VoiceEvent["type"]> = (
  state: VoiceState,
  event: Extract<VoiceEvent, { type: E }>,
) => Step;
type Rules = { [E in VoiceEvent["type"]]: Rule<E> };

const nothing = (state: VoiceState): Step => [state, []];

const parts = (anchor: Anchor) => ({
  before: anchor.original.slice(0, anchor.start),
  after: anchor.original.slice(anchor.end),
});

const insert = (state: VoiceState, insertion: Insertion): Step => [
  { ...state, inserting: insertion },
  [
    // Back to the field as it was, so the text replaces the selection the way
    // typing would, and undo brings it back.
    { do: "writeNow", value: insertion.anchor.original },
    {
      do: "insert",
      start: insertion.anchor.start,
      end: insertion.anchor.end,
      text: insertion.text,
    },
  ],
];

/** Every way listening ends but leaving: the phase is idle before the text goes in. */
const done: Rule<"done"> = (state, { text, stop }) => {
  const idle: VoiceState = { ...state, phase: "idle", asking: false, anchor: null };
  const notice: VoiceEffect = { do: "setNotice", stop };
  const anchor = state.anchor;
  if (!anchor) return [idle, [notice]];
  const { before, after } = parts(anchor);
  const spoken = spokenInsertion(before, text, after);
  if (!spoken) {
    return [
      idle,
      [
        { do: "writeNow", value: anchor.original },
        { do: "select", start: anchor.start, end: anchor.end },
        notice,
      ],
    ];
  }
  const [next, effects] = insert(idle, {
    anchor,
    text: spoken,
    spoken: before + spoken + after,
    retry: false,
  });
  return [next, [...effects, notice]];
};

/** Leaving keeps the heard words where the preview put them, and touches no field. */
const left: Rule<"left"> = (state, { reason }) => {
  const stop: DictationStop = { reason };
  return [
    { ...state, phase: "idle", asking: false, anchor: null },
    [{ do: "cancelListening" }, { do: "setNotice", stop }, { do: "keepNotice", stop }],
  ];
};

const heard: Rule<"heard"> = (state, { text }) => {
  if (!state.anchor) return nothing(state);
  const { before, after } = parts(state.anchor);
  return [state, [{ do: "write", value: before + spokenInsertion(before, text, after) + after }]];
};

/** Rules that hold in every phase. */
const always = {
  asking: (state, { asking }) => [{ ...state, asking }, []],
  inserted: (state) => [{ ...state, inserting: null }, []],
  insertFailed: (state) => {
    const insertion = state.inserting;
    if (!insertion) return nothing(state);
    const write: VoiceEffect = { do: "write", value: insertion.spoken };
    // A hidden field cannot take focus, as when share mode or a card hides the
    // composer. The draft keeps the text, and once the field shows the text
    // goes in again natively, so one undo still removes it.
    if (insertion.retry) return [{ ...state, inserting: null }, [write]];
    return [{ ...state, inserting: null, waiting: insertion }, [write, { do: "watchShown" }]];
  },
  shown: (state, { value }) => {
    const waiting = state.waiting;
    if (!waiting) return nothing(state);
    const cleared = { ...state, waiting: null };
    // The guardian changed the field first: their edit stands.
    if (value !== waiting.spoken) return [cleared, []];
    return insert(cleared, { ...waiting, retry: true });
  },
  edited: (state) => [state, state.inserting ? [] : [{ do: "setNotice", stop: null }]],
  dismissed: (state) => [state, [{ do: "setNotice", stop: null }]],
} satisfies Partial<Rules>;

const rules: Record<VoiceInputState, Rules> = {
  idle: {
    ...always,
    start: (state, { field }) => [
      { ...state, phase: "listening", anchor: field, waiting: null },
      [
        ...(state.waiting ? [{ do: "unwatchShown" } as const] : []),
        { do: "setNotice", stop: null },
        { do: "listen" },
      ],
    ],
    heard: nothing,
    stop: nothing,
    done: nothing,
    // Nothing is listening. A chat that goes drops the wait for its field.
    left: (state, { reason }) =>
      reason === "left-chat" && state.waiting
        ? [{ ...state, waiting: null }, [{ do: "unwatchShown" }]]
        : nothing(state),
  },
  listening: {
    ...always,
    start: nothing,
    heard,
    stop: (state) => [{ ...state, phase: "finishing" }, [{ do: "stopListening" }]],
    done,
    left,
  },
  finishing: {
    ...always,
    start: nothing,
    heard,
    stop: nothing,
    done,
    left,
  },
};

export function next(state: VoiceState, event: VoiceEvent): Step {
  const rule = rules[state.phase][event.type] as Rule<typeof event.type>;
  return rule(state, event as never);
}

import type { TraceChange, TraceMessage } from "./trace.js";

/**
 * How a replay paces a conversation. A scenario runs in milliseconds, so a
 * replay does not follow the recorded timing: it keeps the order of the
 * recorded changes and spaces them out by these settings.
 */
export interface ReplaySettings {
  /** The pause before a new message appears, in milliseconds. */
  messageDelayMs: number;
  /** The pause before an edit of a message already shown, in milliseconds. */
  editDelayMs: number;
  /** Type each message out instead of showing it whole. */
  typewriter: boolean;
  /** How fast the typewriter types, in characters per second. */
  charsPerSecond: number;
  /** The longest the typewriter takes on one message, all its edits together,
   *  whatever its length. A longer message types faster to fit. */
  maxTypingMs: number;
  /** Type the user's messages too. Otherwise only Rome's are typed. */
  typeUserMessages: boolean;
}

// A pause long enough to tell two messages apart and short enough that a
// scenario of a few messages replays in about a second. 40 characters per
// second makes a short reply visibly type, and the cap keeps a long one under
// two seconds.
export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = {
  messageDelayMs: 600,
  editDelayMs: 250,
  typewriter: true,
  charsPerSecond: 40,
  maxTypingMs: 2_000,
  typeUserMessages: false,
};

/** The range each number setting accepts, as `[min, max]`. */
export const REPLAY_LIMITS = {
  messageDelayMs: [0, 10_000],
  editDelayMs: [0, 10_000],
  charsPerSecond: [1, 5_000],
  maxTypingMs: [0, 30_000],
} as const;

/** `raw` read as settings: a missing or invalid field takes its default, and a
 *  number outside its range moves to the nearest end. */
export function normalizeReplaySettings(
  raw: unknown,
  defaults: ReplaySettings = DEFAULT_REPLAY_SETTINGS,
): ReplaySettings {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const number = (key: keyof typeof REPLAY_LIMITS): number => {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return defaults[key];
    const [min, max] = REPLAY_LIMITS[key];
    return Math.min(max, Math.max(min, value));
  };
  const flag = (key: "typewriter" | "typeUserMessages"): boolean => {
    const value = source[key];
    return typeof value === "boolean" ? value : defaults[key];
  };
  return {
    messageDelayMs: number("messageDelayMs"),
    editDelayMs: number("editDelayMs"),
    typewriter: flag("typewriter"),
    charsPerSecond: number("charsPerSecond"),
    maxTypingMs: number("maxTypingMs"),
    typeUserMessages: flag("typeUserMessages"),
  };
}

/** One recorded change, placed on the replay's own clock. */
export interface ReplayBeat {
  kind: "create" | "edit";
  /** When the change starts to show, in milliseconds from the replay's start. */
  start: number;
  /** When its text is complete. Equal to `start` when nothing is typed. */
  end: number;
  /** How many leading characters the message already showed and keeps. */
  keep: number;
  /** When the platform applied the change, on the trace's clock. */
  at: number;
  /** The message as it reads once the change is complete. */
  message: TraceMessage;
}

export interface ReplayPlan {
  beats: ReplayBeat[];
  /** When the last change is complete. */
  duration: number;
}

/**
 * Places `changes`, in their recorded order, on the replay's clock. The first
 * change starts at 0. Each later one starts after the one before it is
 * complete plus the delay for its kind. An edit types only what differs from
 * the text the message showed before, so a streamed reply grows instead of
 * restarting. The typing speed is the setting, or faster when the message
 * would otherwise take longer than `maxTypingMs` across all its edits.
 */
export function planReplay(changes: TraceChange[], settings: ReplaySettings): ReplayPlan {
  // What each change types, and what each message types in all.
  const shown = new Map<string, string>();
  const typedByMessage = new Map<string, number>();
  const planned = changes.map((change) => {
    const { message } = change;
    const before = shown.get(message.id);
    const keep = before === undefined ? 0 : commonPrefixLength(before, message.text);
    const typed = settings.typewriter && (message.from === "rome" || settings.typeUserMessages);
    const characters = typed ? message.text.length - keep : 0;
    shown.set(message.id, message.text);
    typedByMessage.set(message.id, (typedByMessage.get(message.id) ?? 0) + characters);
    return {
      change,
      kind: before === undefined ? ("create" as const) : ("edit" as const),
      keep,
      characters,
    };
  });

  const beats: ReplayBeat[] = [];
  let clock = 0;
  for (const { change, kind, keep, characters } of planned) {
    const { message } = change;
    const start = beats.length === 0 ? 0 : clock + delayFor(kind, settings);
    const speed = Math.max(
      settings.charsPerSecond,
      (typedByMessage.get(message.id) ?? 0) / (settings.maxTypingMs / 1000),
    );
    const typing = characters === 0 || settings.maxTypingMs <= 0 ? 0 : (characters / speed) * 1000;
    beats.push({ kind, start, end: start + typing, keep, at: change.at, message });
    clock = start + typing;
  }
  return { beats, duration: clock };
}

/** A message at one moment of a replay. */
export interface ReplayedMessage {
  /** The message with the text shown so far. */
  message: TraceMessage;
  /** The typewriter is still writing it. */
  typing: boolean;
}

/** The messages a replay shows at `time`, in the order they first appeared. */
export function replayAt(plan: ReplayPlan, time: number): ReplayedMessage[] {
  const shown = new Map<string, ReplayedMessage>();
  for (const beat of plan.beats) {
    if (beat.start > time) break;
    const { message } = beat;
    const typing = time < beat.end;
    const typed = typing
      ? Math.floor(
          ((time - beat.start) / (beat.end - beat.start)) * (message.text.length - beat.keep),
        )
      : message.text.length - beat.keep;
    shown.set(message.id, {
      message: { ...message, text: message.text.slice(0, beat.keep + typed) },
      typing,
    });
  }
  return [...shown.values()];
}

/** The latest change that has started by `time`, if any has. */
export function beatAt(plan: ReplayPlan, time: number): ReplayBeat | undefined {
  return plan.beats.filter((beat) => beat.start <= time).at(-1);
}

function delayFor(kind: ReplayBeat["kind"], settings: ReplaySettings): number {
  return kind === "create" ? settings.messageDelayMs : settings.editDelayMs;
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

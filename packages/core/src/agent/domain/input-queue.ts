// The rules of a session's input queue: which input starts a turn, which is
// steered into the running turn, which waits, what a `now` input supersedes,
// and what a superseded turn carries over. Each rule is a function over values.
// The application queue holds them over time, writes input statuses, and
// steers through the model session.

import type { AgentInputState } from "@rome-os/app-runtime";

/**
 * How an input that arrives during a running turn is handled. `next` steers it
 * into that turn when the provider can, else queues it. `now` ends that turn
 * and starts a new one with it. Either starts a turn when none runs.
 */
export type InputPriority = "now" | "next";

/**
 * What a submit asks for. `after` starts a turn of its own that waits behind
 * the running turn. It is never steered into and supersedes nothing, and it is
 * not one of the queue's inputs. Like any running turn, a `now` input
 * supersedes it.
 */
export type SubmitPriority = InputPriority | "after";

/** Where a submitted input landed: in a turn it started, queued for a later turn, or steered into the running turn. */
export type Landing = "started" | "queued" | "steered";

/** Whether an input goes through the input queue: every priority but `after`. */
export function isQueueInput(priority: SubmitPriority): priority is InputPriority {
  return priority !== "after";
}

/** An `after` input lands queued behind a running turn, and starts its turn when none runs. */
export function afterLanding(turnRunning: boolean): Landing {
  return turnRunning ? "queued" : "started";
}

/** The interrupt reason a `now` input ends the running turn with. */
export const SUPERSEDED_INTERRUPT_REASON = "superseded";

/** An input as the rules see it. Its state is the last status written for it. */
export interface QueuedInput {
  readonly priority: InputPriority;
  readonly state: AgentInputState;
}

/** The inputs of the running turn and how far it accepts more. */
export interface InputTurn<T> {
  readonly first: T;
  /** Inputs folded into `first`'s prompt when the turn started. Their status follows `first`. */
  readonly bound: readonly T[];
  /** `first` and `bound` in the order the turn's prompt holds them. */
  readonly prompted: readonly T[];
  /**
   * Consumed inputs of earlier turns that a `now` input stopped before they
   * finished, in order. The prompt names them as interrupted work ahead of
   * `prompted`. Their status stays `consumed`.
   */
  readonly interrupted: readonly T[];
  /** Inputs steered into the turn, in dispatch order. */
  readonly steered: readonly T[];
  /** The provider has begun the turn and can be steered. */
  readonly ready: boolean;
  /** The steered input the provider has not consumed yet. */
  readonly pending?: T;
  /** No further input is steered into the turn. */
  readonly sealed: boolean;
  /** A `now` input ended this turn. */
  readonly superseded: boolean;
}

/** What happens to an input when it is submitted. */
export interface Arrival {
  landing: Landing;
  /** The running turn is to be stopped, because a `now` input supersedes it. */
  supersede: boolean;
}

/**
 * An input starts a turn when none runs. During a turn a `now` input waits and
 * supersedes the turn, once. A `next` input is steered in while the turn is
 * ready and not sealed, and waits otherwise.
 */
export function arrive<T>(turn: InputTurn<T> | undefined, priority: InputPriority): Arrival {
  if (!turn) return { landing: "started", supersede: false };
  if (priority === "now") return { landing: "queued", supersede: !turn.superseded };
  return { landing: turn.ready && !turn.sealed ? "steered" : "queued", supersede: false };
}

/** What a superseded turn hands the next one. */
export interface Carried<T> {
  /** Inputs the provider never consumed. The next turn prompts them again. */
  readonly inputs: readonly T[];
  /** Inputs the provider consumed in a turn that did not finish. The next turn names them as interrupted work. */
  readonly interrupted: readonly T[];
}

export const NOTHING_CARRIED: Carried<never> = { inputs: [], interrupted: [] };

/**
 * The turn `first` starts, and what stays queued. It takes every input a
 * superseded turn carried over, in front and in order. A `now` input also takes
 * every other queued `now` input, which would only supersede it again. They
 * ride as one prompt, so the model answers the burst once.
 */
export function startTurn<T extends QueuedInput>(
  first: T,
  queued: readonly T[],
  carried: Carried<T>,
): { turn: InputTurn<T>; queued: T[] } {
  const absorbed = first.priority === "now" ? queued.filter((q) => q.priority === "now") : [];
  const rest = queued.filter((q) => !absorbed.includes(q));
  return {
    turn: {
      first,
      bound: [...carried.inputs, ...absorbed],
      prompted: [...carried.inputs, first, ...absorbed],
      interrupted: carried.interrupted,
      steered: [],
      ready: false,
      sealed: false,
      superseded: false,
    },
    queued: rest,
  };
}

/** The line that tells the model the inputs after it are work its stopped turn left unfinished. */
export const INTERRUPTED_WORK_NOTE =
  "Your previous turn was stopped before it finished. It was handling:";

/** The line that separates interrupted work from the new input. */
export const NEW_INPUT_NOTE = "New message:";

/**
 * One prompt holding every input, in order, with all their images. Interrupted
 * work, when there is any, comes first under `INTERRUPTED_WORK_NOTE`, then the
 * parts under `NEW_INPUT_NOTE`.
 */
export function joinPrompts<I extends { prompt: string; images?: string[] }>(
  first: I,
  parts: readonly I[],
  interrupted: readonly I[] = [],
): I {
  if (parts.length === 1 && interrupted.length === 0) return first;
  const prompts = parts.map((part) => part.prompt);
  return {
    ...first,
    prompt: (interrupted.length > 0
      ? [
          INTERRUPTED_WORK_NOTE,
          ...interrupted.map((part) => part.prompt),
          NEW_INPUT_NOTE,
          ...prompts,
        ]
      : prompts
    ).join("\n\n"),
    images: [...interrupted, ...parts].flatMap((part) => part.images ?? []),
  };
}

/** The provider has begun the turn. */
export function markReady<T>(turn: InputTurn<T>): InputTurn<T> {
  return { ...turn, ready: true };
}

/** Sealing first keeps the superseding input from being steered into the turn it ends. */
export function supersede<T>(turn: InputTurn<T>): InputTurn<T> {
  return { ...turn, superseded: true, sealed: true };
}

/** No further input is steered into the turn. */
export function seal<T>(turn: InputTurn<T>): InputTurn<T> {
  return { ...turn, sealed: true };
}

/**
 * One input at a time is steered in, and only once the turn is ready and while
 * it is not sealed.
 */
export function canSteer<T>(turn: InputTurn<T>): boolean {
  return turn.ready && !turn.pending && !turn.sealed;
}

/** `input` is steered into the turn and pending until the provider consumes it. */
export function steer<T>(turn: InputTurn<T>, input: T): InputTurn<T> {
  return { ...turn, pending: input, steered: [...turn.steered, input] };
}

/** `input` is no longer pending in the turn. */
export function release<T>(turn: InputTurn<T>, input: T): InputTurn<T> {
  return turn.pending === input ? { ...turn, pending: undefined } : turn;
}

/**
 * The provider retained `input` across its native turn boundary. The turn takes
 * no more, and the input waits in front for the next turn, which adopts it
 * under the same input id.
 */
export function retain<T>(
  turn: InputTurn<T>,
  input: T,
  queued: readonly T[],
): { turn: InputTurn<T>; queued: T[] } {
  return {
    turn: release(seal(turn), input),
    queued: queued.includes(input) ? [...queued] : [input, ...queued],
  };
}

/**
 * The provider refused a steer and will not take the input in this turn. The
 * turn takes no more, and the input waits in front for the next turn.
 */
export function defer<T>(turn: InputTurn<T>): InputTurn<T> {
  return { ...turn, sealed: true, pending: undefined };
}

/**
 * What a steer's answer means for its input. An input whose status the
 * provider already reported is settled. `deferred` returns it to the queue,
 * and anything else means the provider accepted it.
 */
export function steerOutcome(
  state: AgentInputState,
  result: "accepted" | "deferred" | undefined,
): "settled" | "deferred" | "accepted" {
  if (state === "consumed" || state === "cancelled" || state === "queued") return "settled";
  return result === "deferred" ? "deferred" : "accepted";
}

/** A steer that failed may have been accepted, so its input is never replayed. */
export function failedSteerState(state: AgentInputState): AgentInputState | undefined {
  return state === "consumed" || state === "cancelled" ? undefined : "unknown";
}

/** The inputs bound to `first` take its status once the provider consumed or failed it. */
export function boundFollow<T>(
  turn: InputTurn<T>,
  input: T,
  state: AgentInputState,
): readonly T[] | undefined {
  return input === turn.first && (state === "consumed" || state === "failed")
    ? turn.bound
    : undefined;
}

/**
 * What a superseded turn carries over. `inputs` holds every input it prompted
 * or steered that the provider did not consume and that is not queued again.
 * The provider never saw these, or saw them only in a turn it dropped (Claude
 * resumes from its transcript, which lacks an input it had not read yet). They
 * keep prompt order, so a turn that itself took carried inputs keeps them
 * before `first`.
 *
 * Unless the turn `completed`, `interrupted` holds the work it left unfinished:
 * the interrupted work it took, then the inputs it consumed, each once. The
 * model read them, but its partial answer can make them look handled. A turn
 * that completed hands no interrupted work on, so nothing it answered is sent
 * again.
 */
export function carryOver<T extends QueuedInput>(
  turn: InputTurn<T>,
  queued: readonly T[],
  completed: boolean,
): Carried<T> {
  const taken = [...turn.prompted, ...turn.steered];
  return {
    inputs: taken.filter(
      (input) =>
        input.state !== "consumed" && input.state !== "cancelled" && !queued.includes(input),
    ),
    interrupted: completed
      ? []
      : [...new Set([...turn.interrupted, ...taken.filter((input) => input.state === "consumed")])],
  };
}

/**
 * The statuses an ended turn that was not superseded leaves its inputs in. An
 * input sent but never confirmed is `unknown` and never replayed. A prompted
 * input still queued that the provider did not retain has `failed`.
 */
export function endTurn<T extends QueuedInput>(
  turn: InputTurn<T>,
  queued: readonly T[],
): Array<[T, AgentInputState]> {
  const updates: Array<[T, AgentInputState]> = [];
  for (const input of [turn.first, ...turn.bound, turn.pending]) {
    if (input && (input.state === "accepted" || input.state === "submitted"))
      updates.push([input, "unknown"]);
  }
  for (const input of [turn.first, ...turn.bound]) {
    if (input.state === "queued" && !queued.includes(input)) updates.push([input, "failed"]);
  }
  return updates;
}

/**
 * The next turn starts with the first queued input, else the first carried one.
 * Interrupted work never starts a turn on its own: it waits for an input.
 */
export function nextInput<T>(
  queued: readonly T[],
  carried: Carried<T>,
): { next?: T; queued: T[]; carried: Carried<T> } {
  if (queued.length > 0) return { next: queued[0], queued: queued.slice(1), carried };
  return {
    next: carried.inputs[0],
    queued: [],
    carried: { ...carried, inputs: carried.inputs.slice(1) },
  };
}

/** An input in one of these states will see no further status. */
export function isSettled(state: AgentInputState): boolean {
  return state === "consumed" || state === "unknown" || state === "failed" || state === "cancelled";
}

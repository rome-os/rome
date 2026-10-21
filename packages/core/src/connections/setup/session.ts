// Connection setup coroutine pump. Vocabulary: docs/domains/connections.md.
//
// One session drives one builder-written `setup(interact, ctx)` coroutine.
// The pump suspends the coroutine at each verb; the pending verb IS the
// poll-able state. `show()` is genuinely non-blocking, so the runtime also holds
// a `presenting` snapshot (the last shown view, or a default working view) that
// is what a cold re-attach renders while the coroutine is blocked inside a
// `ctx.step` external-event wait.
//
// Terminal conferral: the coroutine's `return` is the ONE durable write. The
// pump calls `commit` with the returned conferral and only then reports `done` —
// so `done` is never observable before the ledger write lands. Abandoning or
// cancelling runs no commit at all: nothing half-conferred is ever observable.
//
// Cancellation genuinely interrupts: `cancel()` aborts the setup signal
// (rejecting an in-flight `ctx.step` wait via a race even if its `fn` ignores
// the signal) AND rejects a coroutine suspended at `prompt`/`redirect`, so the
// coroutine unwinds to `cancelled`.

import type {
  SetupConferral,
  SetupContext,
  SetupFn,
  SetupForm,
  SetupInteraction,
  SetupState,
  SetupView,
} from "./types.js";

/** Thrown to unwind a coroutine when its setup is cancelled. */
export class SetupAbortError extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "SetupAbortError";
  }
}

/** The default snapshot shown while a coroutine awaits an external event inside
 *  `ctx.step` before it has shown any view of its own. */
const DEFAULT_WORKING_VIEW: SetupView = { progress: true, body: ["Working…"] };

/** The outcome of feeding input (or a redirect return) into a session: whether
 *  the runtime consumed it, plus the settled state that resulted. */
export interface SetupInputOutcome {
  accepted: boolean;
  reason?: string;
  state: SetupState;
}

export interface SetupSessionDeps {
  /** The builder's coroutine. */
  fn: SetupFn;
  /** The single durable write, run exactly once when the coroutine returns. A
   *  throw here fails the setup (nothing partial is left observable). It
   *  answers the id of the connection it wrote, which `done` reports. */
  commit: (conferral: SetupConferral, signal: AbortSignal) => Promise<string | void>;
  /** Optional override of the default working view (progress snapshot). */
  workingView?: SetupView;
  /** The setup renews a connection that already names its account. */
  renewing?: boolean;
}

type PendingKind = "input" | "redirect";

export class SetupSession {
  readonly #deps: SetupSessionDeps;
  readonly #abort = new AbortController();
  readonly #workingView: SetupView;

  #state: SetupState;
  #lastView: SetupView | null = null;
  #pending: {
    kind: PendingKind;
    resolve: (answers: Record<string, string>) => void;
    reject: (err: unknown) => void;
  } | null = null;
  #terminal = false;
  #parkWaiters: Array<() => void> = [];
  readonly #firstPark: Promise<void>;

  constructor(deps: SetupSessionDeps) {
    this.#deps = deps;
    this.#workingView = deps.workingView ?? DEFAULT_WORKING_VIEW;
    this.#state = { status: "presenting", view: this.#workingView };
    // Register the first-park waiter BEFORE the coroutine can park.
    this.#firstPark = this.#nextPark();
    void this.#run();
  }

  /** Resolves once the coroutine has reached its first stable state (its first
   *  verb, or a terminal state). The manager awaits this so the start response
   *  carries the real initial state. */
  started(): Promise<void> {
    return this.#firstPark;
  }

  get state(): SetupState {
    return this.#state;
  }

  get isTerminal(): boolean {
    return this.#terminal;
  }

  /** Feed the guardian's answers to a coroutine suspended at `prompt`. Idempotent
   *  against late/double delivery: a call when not awaiting input is rejected
   *  (`accepted: false`) rather than mis-applied. Resolves once the coroutine has
   *  settled at its next stable state (which may be a re-prompt carrying a
   *  validation error, the next view, or a terminal state). */
  provideInput(answers: Record<string, string>): Promise<SetupInputOutcome> {
    return this.#resume("input", answers);
  }

  /** Feed the return-leg payload to a coroutine suspended at `redirect`. */
  provideReturn(payload: Record<string, string>): Promise<SetupInputOutcome> {
    return this.#resume("redirect", payload);
  }

  /** Cancel the setup: abort the signal (interrupting any in-flight
   *  `ctx.step`) and reject a coroutine suspended at `prompt`/`redirect`, then
   *  resolve once it has unwound to `cancelled`. No commit runs — zero durable
   *  state. */
  async cancel(): Promise<SetupState> {
    if (this.#terminal) return this.#state;
    const parked = this.#nextPark();
    this.#abort.abort();
    if (this.#pending) {
      const pending = this.#pending;
      this.#pending = null;
      pending.reject(new SetupAbortError());
    }
    await parked;
    return this.#state;
  }

  async #resume(kind: PendingKind, answers: Record<string, string>): Promise<SetupInputOutcome> {
    if (this.#terminal) {
      return { accepted: false, reason: "Setup already finished.", state: this.#state };
    }
    const pending = this.#pending;
    if (!pending || pending.kind !== kind) {
      const reason = kind === "input" ? "Not awaiting input." : "Not awaiting a redirect return.";
      return { accepted: false, reason, state: this.#state };
    }
    const parked = this.#nextPark();
    this.#pending = null;
    pending.resolve(answers);
    await parked;
    return { accepted: true, state: this.#state };
  }

  async #run(): Promise<void> {
    const interact: SetupInteraction = {
      prompt: (form) => this.#suspend("input", form),
      show: (view) => this.#show(view),
      redirect: (url) => this.#suspendRedirect(url),
    };
    const ctx: SetupContext = {
      signal: this.#abort.signal,
      step: (label, fn) => this.#step(label, fn),
      renewing: this.#deps.renewing === true,
    };
    try {
      const conferral = await this.#deps.fn(interact, ctx);
      // The one durable write; `done` is set only after it resolves.
      const connectionId = await this.#deps.commit(conferral, this.#abort.signal);
      this.#terminate({
        status: "done",
        conferral: { summary: conferral.summary, ...(connectionId ? { connectionId } : {}) },
      });
    } catch (err) {
      if (this.#abort.signal.aborted) {
        this.#terminate({ status: "cancelled" });
      } else {
        this.#terminate({ status: "failed", reason: errorMessage(err) });
      }
    }
  }

  #suspend(kind: "input", form: SetupForm & { error?: string }): Promise<Record<string, string>> {
    return new Promise<Record<string, string>>((resolve, reject) => {
      this.#pending = { kind, resolve, reject };
      const { error, ...rest } = form;
      this.#setState(
        error !== undefined
          ? { status: "awaiting-input", form: rest, error }
          : { status: "awaiting-input", form: rest },
      );
      this.#park();
    });
  }

  #suspendRedirect(url: string): Promise<Record<string, string>> {
    return new Promise<Record<string, string>>((resolve, reject) => {
      this.#pending = { kind: "redirect", resolve, reject };
      this.#setState({ status: "awaiting-redirect", url });
      this.#park();
    });
  }

  #show(view: SetupView): void {
    this.#lastView = view;
    this.#setState({ status: "presenting", view });
  }

  async #step<T>(_label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#abort.signal.aborted) throw new SetupAbortError();
    // The step entry is a stable park point: render the last shown view (or the
    // working snapshot) while the external event is awaited.
    this.#setState({ status: "presenting", view: this.#lastView ?? this.#workingView });
    this.#park();
    return raceAbort(this.#abort.signal, fn);
  }

  #terminate(state: SetupState): void {
    this.#terminal = true;
    this.#setState(state);
    this.#park();
  }

  #setState(state: SetupState): void {
    this.#state = state;
  }

  /** Notify every waiter registered for the next park (a stable-state boundary:
   *  a verb suspension, a `ctx.step` entry, or a terminal state). */
  #park(): void {
    const waiters = this.#parkWaiters;
    this.#parkWaiters = [];
    for (const wake of waiters) wake();
  }

  #nextPark(): Promise<void> {
    return new Promise<void>((resolve) => this.#parkWaiters.push(resolve));
  }
}

/** Race a possibly-uncancellable `fn` against the abort signal. The `fn` gets
 *  the signal (so a cooperative wait cancels cleanly), and the runtime also
 *  rejects on abort even if `fn` ignores it — the setup never hangs on a
 *  builder that forgets to honor the signal. */
function raceAbort<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new SetupAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SetupAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    fn(signal).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Resolve after `ms`, or reject with `SetupAbortError` the moment the signal
 *  aborts — the sleep primitive for polling setup coroutines, so a cancel
 *  interrupts the wait instead of letting the loop sleep it out. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SetupAbortError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SetupAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

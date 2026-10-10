import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { Clock, ClockTimer } from "../../lib/clock.js";
import { createLogger } from "../../logger.js";
import { ReplyAssembler } from "./assembler.js";
import { Outlasted, type Pacer, SKIPPED } from "./pacer.js";
import { lastBreak, splitPoint, splitsPair } from "./split.js";
import {
  asDeliveryFailure,
  DeliveryFailure,
  type DeliveryMode,
  type DeliveryPolicy,
  type DeliveryTransport,
  effectiveMode,
  type PartReceipt,
} from "./types.js";

const log = createLogger("reply-delivery");

/** A write the reply made, reported as it finishes. */
export interface DeliveryEvent {
  /** Epoch milliseconds when the write finished. */
  at: number;
  write: "create" | "edit";
  block: number;
  part: number;
  text: string;
  result: "accepted" | DeliveryFailure["kind"];
}

/** One message of the reply, as it stands. */
interface DeliveredPart {
  block: number;
  /** The text the platform shows, as far as Rome knows. */
  text: string;
  receipt?: PartReceipt;
  /**
   * `settled`: its text is final. `open`: a preview the reply never settled.
   * `unknown`: the create may or may not have happened.
   */
  state: "settled" | "open" | "unknown";
  /** The agent's final text for this part differs from what the platform
   *  shows, and the part could not be edited to match. */
  diverged?: true;
}

export interface ReplyOutcome {
  /**
   * `delivered`: every part settled. `partial`: some parts were accepted
   * before a failure. `failed`: none was. `unknown`: a create may or may not
   * have happened, or an edit's result is unknown and nothing put it right,
   * even when the reply was then stopped or failed otherwise. `stopped`: the
   * run was stopped.
   */
  status: "delivered" | "partial" | "failed" | "unknown" | "stopped";
  parts: DeliveredPart[];
  /**
   * A part shows text that differs from the agent's final text, and could not
   * be edited to match. The status is unchanged, so a caller that must know
   * the reply is faithful reads this and need not scan `parts`.
   */
  diverged?: true;
  /**
   * Why the reply stopped. A platform's refusal has a `DeliveryFailure` kind.
   * `overflow` is a reply that outran its bound on unsent text, and `internal`
   * is a fault in the engine or its codec, which no platform caused.
   */
  failure?: { kind: DeliveryFailure["kind"] | "overflow" | "internal"; message: string };
}

export interface ReplyOptions {
  transport: DeliveryTransport;
  /**
   * The pacer of the account the transport writes as. Whoever wires the
   * engine builds it from the transport's declared `capabilities.budget`, one
   * per account. A test may pass an open one to leave rate limits out.
   */
  pacer: Pacer;
  policy: DeliveryPolicy;
  conversation: string;
  /** The message the reply answers. Only its first message points at it. */
  replyTo?: string;
  clock: Clock;
  observe?: (event: DeliveryEvent) => void;
}

interface Part {
  /** The source range the part holds. `end` grows while the part is open. */
  start: number;
  end: number;
  /** What the platform shows, and the source text behind it. */
  sent: string;
  sentSource: string;
  receipt?: PartReceipt;
  settled: boolean;
  unknown?: true;
  /**
   * An edit's result is unknown: the platform may show the text it asked for.
   * The text the part last had acknowledged proves nothing about what the
   * platform shows, so only an edit that succeeds settles it.
   */
  uncertain?: true;
  /** The source of the edit whose result is unknown. The platform may show
   *  it, so it counts as shown, though `sentSource` is what was acknowledged. */
  attempted?: string;
  diverged?: true;
  lastWriteAt: number;
}

interface BlockState {
  parts: Part[];
  /** The source offset up to which text was passed over because a split left
   *  nothing visible in it. The next part starts here at the earliest. */
  skipped?: number;
  /** When unsent text started waiting, in `blocks` mode. */
  waitingSince?: number;
}

type Plan =
  | { write: "create"; block: number; start: number; end: number; source: string; settle: boolean }
  | { write: "edit"; block: number; part: Part; end: number; source: string; settle: boolean }
  | { waitUntil: number }
  | null;

/** The most a reply waits out platform rate limits, in all. A guardian is not
 *  served by a reply that arrives after a flood wait of minutes. Past it, the
 *  reply fails `rate-limited`, which a caller can send whole instead. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** Consecutive edits with an unknown result before the reply gives up. */
const MAX_UNKNOWN_EDITS = 3;

/** How long a write may wait in the account's queue before the reply gives up
 *  on it: the most it waits out of rate limits, and a second for the queue's
 *  own spacing, so a limit of exactly that long still passes. It counts from
 *  the end of the reply's own limit, so the writes of other conversations that
 *  go first once the pause ends do not use it up. */
const QUEUE_WAIT_MS = MAX_RATE_LIMIT_WAIT_MS + 1000;

/** How long a write may run before the reply stops waiting for its answer. */
const WRITE_DEADLINE_MS = 30_000;

/** A write that waited too long in the account's queue. It never started. */
class QueueWaitExceeded extends Error {
  constructor() {
    super(`a write waited more than ${QUEUE_WAIT_MS / 1000} s in the account's queue`);
  }
}

/** A write the platform did not answer in time. It may have done it. */
class WriteTimedOut extends DeliveryFailure {
  constructor() {
    super("unknown", `the platform did not answer within ${WRITE_DEADLINE_MS / 1000} s`);
  }
}

/**
 * Delivers one run's reply to one conversation as its text arrives: every
 * commentary and the answer, each split into as many messages as the
 * platform's limit needs.
 *
 * - In `edit` mode a message appears once its first text exists and keeps
 *   being replaced, at most once per `editIntervalMs`, until it is full or its
 *   block complete. In `blocks` mode a message is sent once its text is
 *   settled, or has waited `blockWaitMs` and ends at a readable break. In
 *   `final` mode nothing is sent before `finish()`.
 * - One write runs at a time, through the account's Pacer. When the Pacer
 *   lets it run, the write carries the latest text, so a preview that went
 *   stale while it waited is never sent. A write whose target is gone, or that
 *   waited past the reply's failure, is dropped.
 * - A message is never created for text with nothing visible in it, since a
 *   platform refuses one. The reply waits for visible text instead.
 * - A message never receives text older than what it shows.
 * - An edit whose result is unknown leaves its part uncertain. The part is
 *   edited again to the text it should show, even when that matches the text
 *   last acknowledged, and only a successful edit settles it. The text that
 *   edit carried counts as shown, so no later part ends before it. If the
 *   block then ends with nothing to put back, or the platform then refuses or
 *   will not edit, or a rate limit ends the reply, it is `unknown`.
 * - A platform's rate limit pauses the account for the time it names, even
 *   when the reply gives up on it. A reply waits out at most a minute of its
 *   own limits in all, and then fails `rate-limited`. A write that has waited
 *   a minute in the account's queue fails the reply, so `finish()` is not held
 *   for as long as another reply's flood wait. It is `rate-limited` when a
 *   pause from elsewhere on the account holds it, and `unavailable` when its
 *   conversation is still held by an earlier call.
 * - A create whose result is unknown is never repeated: the reply stops
 *   writing and reports `unknown`.
 * - A write the platform does not answer within 30 s stops holding the reply.
 *   It counts as unknown, is not repeated, and the call is left to finish
 *   unheeded, so `stop()` and `finish()` return within that time. The
 *   conversation stays busy in the pacer until the call really ends, so a later
 *   write to it cannot overtake it.
 * - After `stop()`, nothing new is written. A write already running finishes
 *   and is reported, and a create whose result is unknown stays `unknown`.
 *
 * The run's events go to `accept()`. `finish()` closes the reply once the run
 * ends and resolves when every write has finished.
 */
export class ReplyDelivery {
  private readonly assembler = new ReplyAssembler();
  private readonly blocks: BlockState[] = [];
  private readonly abort = new AbortController();
  private mode: DeliveryMode;
  /** Where messages go. After the first create it follows the id the platform
   *  reports, which can differ from the one the reply started with. */
  private conversation: string;
  /** The pacer's key for every write of this reply: the conversation it
   *  started in, whatever the platform later reports, so that the
   *  conversation's spacing holds. */
  private readonly paceKey: string;
  private closed = false;
  private writing = false;
  private failure?: ReplyOutcome["failure"];
  private unknownEdits = 0;
  private rateLimitedMs = 0;
  /** When the pause for the reply's own rate limits ends. */
  private ownPausedUntil = 0;
  /** The transport call of the write that just timed out, still running. */
  private outlasting?: Promise<unknown>;
  private timer?: ClockTimer;
  private readonly idle: Array<() => void> = [];

  constructor(private readonly options: ReplyOptions) {
    this.mode = effectiveMode(options.policy, options.transport.capabilities);
    const longest = options.transport.capabilities.maxPartLength;
    // An open preview counts as unsent until the edit that settles it has run,
    // and that edit waits its turn while the text goes on arriving. A bound
    // that cannot hold one message fails every reply while its first message
    // fills, and one just above it fails most replies of more than one, so it
    // is refused up front. A real policy gives far more than the least.
    if (this.mode !== "final" && options.policy.maxPendingChars < 2 * longest)
      throw new Error(
        `maxPendingChars (${options.policy.maxPendingChars}) must be at least twice the platform's longest message (${longest})`,
      );
    this.conversation = options.conversation;
    this.paceKey = options.conversation;
  }

  /** Takes one event of the run. Events after `finish()` or `stop()` are ignored. */
  accept(event: StreamAgentEvent): void {
    if (this.closed || this.failure) return;
    this.assembler.apply(event);
    // The block's text can differ from what streamed, so what was passed over
    // and where parts end are checked before text is counted as unsent. A
    // codec that throws fails the reply, as it does when planning.
    try {
      for (const [index, block] of this.assembler.blocks.entries()) {
        const state = this.blocks[index];
        if (state) this.reconcileLayout(block.text, state);
      }
    } catch (error) {
      this.fail({
        kind: "internal",
        message: error instanceof Error ? error.message : String(error),
      });
      this.pump();
      return;
    }
    const waiting = this.pendingChars();
    // A `final` reply waits for its end by design, so nothing bounds its text.
    if (this.mode !== "final" && waiting > this.options.policy.maxPendingChars)
      this.fail({ kind: "overflow", message: `${waiting} characters wait unsent` });
    this.pump();
  }

  /**
   * The reply cannot say what a message shows: its last edit's result is
   * unknown, and the text that would put it right is blank, which a platform
   * refuses. The reply ends `unknown`, and a caller does not send it again.
   */
  private failUncertain(): null {
    this.fail({
      kind: "unknown",
      message: "an edit's result is unknown and the block ended with nothing to put back",
    });
    return null;
  }

  /**
   * Source text that is not in a settled message yet: in every block that is
   * still streaming, what follows its last settled part or the prefix passed
   * over, including a preview that is still open. A block the agent completed
   * is not counted. It was produced whole and is already held in full, so it
   * is no backlog, and it can be split and sent. It is read off the blocks and
   * parts, so text a split passed over, and a block that shrank, cannot leave
   * it drifting.
   */
  private pendingChars(): number {
    let total = 0;
    for (const [index, block] of this.assembler.blocks.entries()) {
      if (block.complete) continue;
      const state = this.blocks[index];
      let consumed = state?.skipped ?? 0;
      for (let i = (state?.parts.length ?? 0) - 1; i >= 0; i--) {
        const part = state!.parts[i]!;
        if (!part.settled) continue;
        consumed = Math.max(consumed, part.end);
        break;
      }
      total += Math.max(0, block.text.length - consumed);
    }
    return total;
  }

  /** Closes the reply and resolves once every part is written or the reply
   *  can write no more. */
  finish(): Promise<ReplyOutcome> {
    this.closed = true;
    return this.settle();
  }

  /** Stops writing at once. Resolves when a write already running ends. */
  stop(): Promise<ReplyOutcome> {
    this.closed = true;
    this.abort.abort();
    return this.settle();
  }

  private settle(): Promise<ReplyOutcome> {
    return new Promise((resolve) => {
      this.idle.push(() => resolve(this.outcome()));
      this.pump();
    });
  }

  private fail(failure: NonNullable<ReplyOutcome["failure"]>) {
    this.failure ??= failure;
    this.closed = true;
  }

  private now(): number {
    return this.options.clock.now().getTime();
  }

  private pump(): void {
    if (this.writing) return;
    if (this.timer) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const plan = this.failure || this.abort.signal.aborted ? null : this.planSafely(this.now());
    if (plan === null) {
      if (this.closed) for (const done of this.idle.splice(0)) done();
      return;
    }
    if ("waitUntil" in plan) {
      this.timer = this.options.clock.setTimeout(() => this.pump(), plan.waitUntil - this.now());
      return;
    }
    this.writing = true;
    // A write waits in the account's queue behind whatever pauses it. A pause
    // that came from elsewhere is not this reply's to wait out for an hour.
    const queued = new AbortController();
    const queuedAt = this.now();
    const ownPause = Math.max(0, this.ownPausedUntil - queuedAt);
    const queueTimer = this.options.clock.setTimeout(
      () => queued.abort(new QueueWaitExceeded()),
      ownPause + QUEUE_WAIT_MS,
    );
    void this.options.pacer
      .run(
        this.paceKey,
        async (): Promise<void | typeof SKIPPED | Outlasted> => {
          this.options.clock.clearTimeout(queueTimer);
          // The reply can change while a write waits its turn. Its text may
          // have grown, it may have failed, and the write may have become
          // unnecessary. Only a write for the same target runs, with the
          // latest text. A write that does not run costs the pacer nothing.
          if (this.failure) return SKIPPED;
          // Planned on a copy of the bookkeeping, so that planning again cannot
          // change the reply. The next planning notes what this one would have.
          const fresh = this.planSafely(this.now(), true, true);
          if (!fresh || !sameTarget(fresh, plan)) return SKIPPED;
          await this.write(fresh);
          // A call the reply stopped waiting for is still running. The pacer
          // keeps the conversation busy until it ends, so a later write to it
          // cannot overtake it.
          const late = this.outlasting;
          this.outlasting = undefined;
          return late ? new Outlasted(late) : undefined;
        },
        AbortSignal.any([this.abort.signal, queued.signal]),
      )
      .catch((error: unknown) => {
        // A write the stop dropped before it ran: nothing happened.
        if (this.abort.signal.aborted) return;
        if (error instanceof QueueWaitExceeded) {
          // A pause that was in effect while the write waited, even one that is
          // over by now, is a limit the caller can wait out. With none, the
          // conversation is still held by an earlier call, and waiting out a
          // limit would not help. Either way, the write never started.
          const paused = this.options.pacer.lastPauseEnd() > queuedAt;
          this.fail({ kind: paused ? "rate-limited" : "unavailable", message: error.message });
          return;
        }
        // Anything else escaped the write's own handling of the transport's
        // errors, such as a codec that throws. Left alone it would plan the
        // same write again, so the reply fails.
        const message = error instanceof Error ? error.message : String(error);
        log.warn("reply write failed outside the transport", { error: message });
        this.fail({ kind: "internal", message });
      })
      .finally(() => {
        this.options.clock.clearTimeout(queueTimer);
        this.writing = false;
        this.pump();
      });
  }

  /** `plan`, where a fault in planning fails the reply instead of throwing
   *  into whoever fed it text, or into the pacer. */
  private planSafely(now: number, ignoreWaits = false, dry = false): Plan {
    try {
      return this.plan(now, ignoreWaits, dry);
    } catch (error) {
      this.fail({
        kind: "internal",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The next write, or when to look again, or null when there is nothing
   *  to do until more text arrives. `now` decides waits; `ignoreWaits` plans
   *  as though every wait were over.
   *
   *  It runs twice per write, once to choose it and once when the pacer lets
   *  it run. It also brings the reply's bookkeeping up to date with the text,
   *  such as what was passed over and which parts differ. The second run is
   *  `dry`: it plans on a copy of that bookkeeping and fails nothing, so it
   *  cannot change the reply, and the next planning notes what it would have. */
  private plan(now: number, ignoreWaits = false, dry = false): Plan {
    // Nothing is written before the reply finishes, so there is nothing to plan.
    if (this.mode === "final" && !this.closed) return null;
    const { codec, capabilities } = this.options.transport;
    const limit = capabilities.maxPartLength;
    const blocks = dry ? this.snapshot() : this.blocks;
    for (const [index, block] of this.assembler.blocks.entries()) {
      const state = (blocks[index] ??= { parts: [] });
      // A part of the copy is the reply's own part again when a write names it.
      const own = (part: Part) =>
        dry ? this.blocks[index]!.parts[state.parts.indexOf(part)]! : part;
      const complete = block.complete || this.closed;
      this.reconcileLayout(block.text, state);

      for (const part of state.parts) {
        if (!part.settled || part.diverged || part.unknown) continue;
        const source = block.text.slice(part.start, part.end);
        if (source === part.sentSource && !part.uncertain) continue;
        const rendered = codec.render(source, true);
        // A platform refuses a blank edit, so a message whose place in the block
        // is now empty stays as it is, and the part is reported as differing.
        // If its last edit's result is unknown, nothing can put its text back.
        if (!rendered.trim()) {
          if (part.uncertain) return dry ? null : this.failUncertain();
          part.diverged = true;
          continue;
        }
        if (this.mode !== "edit" || codec.measure(rendered) > limit) {
          part.diverged = true;
          continue;
        }
        if (rendered === part.sent && !part.uncertain) {
          part.sentSource = source;
          continue;
        }
        const due = part.lastWriteAt + this.options.policy.editIntervalMs;
        if (now < due && !ignoreWaits) return { waitUntil: due };
        return {
          write: "edit",
          block: index,
          part: own(part),
          end: part.end,
          source,
          settle: true,
        };
      }

      for (;;) {
        const last = state.parts.at(-1);
        if (last?.unknown) return null;
        const active = last && !last.settled ? last : undefined;
        const start = active ? active.start : Math.max(last?.end ?? 0, state.skipped ?? 0);
        const remaining = block.text.slice(start);
        // Nothing visible yet, or only a whitespace tail after a split. A
        // platform refuses a message with no visible text, and one refusal
        // ends the reply.
        if (!remaining || !codec.render(remaining, true).trim()) {
          if (!complete) return null;
          // The block ended with nothing more to show. A preview it already
          // shows cannot be taken back, so it stays as shown, and the part
          // is reported as differing from the final text.
          if (active) {
            if (active.uncertain) return dry ? null : this.failUncertain();
            active.diverged = true;
            this.settlePart(active, active.start + active.sentSource.length);
          }
          state.skipped = block.text.length;
          break;
        }
        let end = start + splitPoint(remaining, limit, codec);
        // A message never gives back text it already shows to the next one.
        const shown = active
          ? active.start + Math.max(active.sentSource.length, active.attempted?.length ?? 0)
          : start;
        if (
          end < shown &&
          codec.measure(codec.render(block.text.slice(start, shown), true)) <= limit
        )
          end = Math.min(shown, block.text.length);
        // What a preview showed can end inside a pair of the final text.
        if (end > start + 1 && splitsPair(block.text, end)) end -= 1;
        const settle = complete || end < block.text.length;
        const source = block.text.slice(start, end);
        // The split can choose a prefix with nothing visible in it, such as a
        // long run of spaces. It is passed over without a message, and the
        // visible rest starts the next part.
        if (!codec.render(source, settle).trim()) {
          // A preview already shown at the start of this text stays as it is,
          // since a blank edit is refused, and is reported as differing.
          if (active) {
            if (active.uncertain) return dry ? null : this.failUncertain();
            active.diverged = true;
            this.settlePart(active, active.start + active.sentSource.length);
          }
          state.skipped = end;
          continue;
        }

        if (active) {
          if (codec.render(source, settle) === active.sent && !active.uncertain) {
            if (!settle) return null;
            this.settlePart(active, end);
            continue;
          }
          const due = active.lastWriteAt + this.options.policy.editIntervalMs;
          if (now < due && !ignoreWaits) return { waitUntil: due };
          return { write: "edit", block: index, part: own(active), end, source, settle };
        }
        if (this.mode === "edit" || settle) {
          state.waitingSince = undefined;
          return { write: "create", block: index, start, end, source, settle };
        }
        state.waitingSince ??= now;
        const due = state.waitingSince + this.options.policy.blockWaitMs;
        if (now < due && !ignoreWaits) return { waitUntil: due };
        // The wait is over, but the text may stop mid-word, and a part cannot be
        // edited back together. It ends at the last readable break, and what
        // follows waits. With no break yet, all of it keeps waiting, and the
        // text that completes a break sends the part at once.
        const cut = lastBreak(source);
        if (cut === 0 || !codec.render(source.slice(0, cut), true).trim()) return null;
        state.waitingSince = undefined;
        return {
          write: "create",
          block: index,
          start,
          end: start + cut,
          source: source.slice(0, cut),
          settle: true,
        };
      }
    }
    return null;
  }

  /** A copy of the blocks' bookkeeping, for planning that must not change it. */
  private snapshot(): BlockState[] {
    return this.blocks.map((state) => ({
      ...state,
      parts: state.parts.map((part) => ({ ...part })),
    }));
  }

  /**
   * Parts keep the offsets they got while the text streamed, and a block's
   * final text can differ from it. Two things then need another look.
   *
   * A boundary can fall inside a surrogate pair. It moves back before the
   * pair, which shortens the part it ends and lengthens the one it starts.
   *
   * A split passes over text with nothing visible in it and sends nothing for
   * it, and that text can turn visible. Text behind the last message is simply
   * sent. Text between two messages cannot be, since a message cannot be put in
   * front of one that exists, so the message after it is reported as differing.
   */
  private reconcileLayout(text: string, state: BlockState): void {
    const { codec } = this.options.transport;
    const visible = (from: number, to: number) =>
      to > from && codec.render(text.slice(from, to), true).trim() !== "";
    let covered = 0;
    for (const part of state.parts) {
      if (splitsPair(text, part.start)) part.start -= 1;
      if (splitsPair(text, part.end)) part.end -= 1;
      if (!part.diverged && visible(covered, part.start)) part.diverged = true;
      covered = Math.max(covered, part.end);
    }
    if (state.skipped === undefined) return;
    if (splitsPair(text, state.skipped)) state.skipped -= 1;
    if (visible(covered, state.skipped)) state.skipped = undefined;
  }

  private async write(plan: Exclude<Plan, null | { waitUntil: number }>): Promise<void> {
    const { transport, observe } = this.options;
    const state = this.blocks[plan.block]!;
    const rendered = transport.codec.render(plan.source, plan.settle);
    const report = (result: DeliveryEvent["result"], part: number) => {
      try {
        observe?.({
          at: this.now(),
          write: plan.write,
          block: plan.block,
          part,
          text: rendered,
          result,
        });
      } catch (error) {
        // An observer is a diagnostic. It cannot change what a write did.
        log.warn("delivery observer threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    if (plan.write === "create") {
      const first = this.blocks.every((block) => block.parts.length === 0);
      const partIndex = state.parts.length;
      try {
        const receipt = await this.answered(
          transport.create(this.conversation, rendered, first ? this.options.replyTo : undefined),
        );
        // Later messages follow the first wherever it landed.
        this.conversation = receipt.conversationId;
        const part: Part = {
          start: plan.start,
          end: plan.end,
          sent: rendered,
          sentSource: plan.source,
          receipt,
          settled: false,
          lastWriteAt: this.now(),
        };
        state.parts.push(part);
        if (plan.settle) this.settlePart(part, plan.end);
        report("accepted", partIndex);
      } catch (error) {
        const failure = asDeliveryFailure(error);
        report(failure.kind, partIndex);
        if (failure.kind === "unknown")
          state.parts.push({
            start: plan.start,
            end: plan.end,
            sent: rendered,
            sentSource: plan.source,
            settled: false,
            unknown: true,
            lastWriteAt: this.now(),
          });
        this.handle(failure);
      }
      return;
    }

    const { part } = plan;
    const partIndex = state.parts.indexOf(part);
    try {
      if (!transport.edit)
        throw new DeliveryFailure("unsupported", "the transport declares edits but has no edit");
      await this.answered(transport.edit(part.receipt!, rendered));
      Object.assign(part, { sent: rendered, sentSource: plan.source, lastWriteAt: this.now() });
      delete part.uncertain;
      delete part.attempted;
      if (!part.settled) part.end = plan.end;
      if (plan.settle && !part.settled) this.settlePart(part, plan.end);
      this.unknownEdits = 0;
      report("accepted", partIndex);
    } catch (error) {
      const failure = asDeliveryFailure(error);
      report(failure.kind, partIndex);
      part.lastWriteAt = this.now();
      if (failure.kind === "unknown") {
        part.uncertain = true;
        part.attempted = plan.source;
      }
      if (failure.kind === "unsupported" && !part.uncertain) {
        // The platform will not edit: keep what it shows and carry on in blocks.
        this.mode = "blocks";
        if (!part.settled) this.settlePart(part, part.start + part.sentSource.length);
        return;
      }
      if (failure.kind === "unsupported") {
        // An earlier edit's result is unknown, so what the part shows is not
        // known, and nothing can put its text back.
        this.fail({ kind: "unknown", message: failure.message });
        return;
      }
      // A write that timed out is not tried again: a transport that does not
      // answer would hold the reply for another deadline each time.
      if (
        failure.kind === "unknown" &&
        !(failure instanceof WriteTimedOut) &&
        ++this.unknownEdits < MAX_UNKNOWN_EDITS
      )
        return;
      this.handle(failure);
    }
  }

  private handle(failure: DeliveryFailure): void {
    if (failure.kind === "rate-limited") {
      const wait = failure.retryAfterMs ?? 1000;
      // A platform's answer does not say whose limit it hit, so the whole
      // account waits. It does so when the reply gives up too, since a send the
      // caller makes next would run into the same window.
      this.options.pacer.pause(wait);
      this.ownPausedUntil = Math.max(this.ownPausedUntil, this.now() + wait);
      if (this.rateLimitedMs + wait > MAX_RATE_LIMIT_WAIT_MS) {
        this.fail({ kind: "rate-limited", message: failure.message });
        return;
      }
      this.rateLimitedMs += wait;
      return;
    }
    this.fail({ kind: failure.kind, message: failure.message });
  }

  /** `call`'s answer, or a `WriteTimedOut` when the platform does not give one in time. */
  private async answered<T>(call: Promise<T>): Promise<T> {
    let timer: ClockTimer | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = this.options.clock.setTimeout(() => reject(new WriteTimedOut()), WRITE_DEADLINE_MS);
    });
    try {
      return await Promise.race([call, deadline]);
    } catch (error) {
      if (error instanceof WriteTimedOut) this.outlasting = call;
      throw error;
    } finally {
      if (timer) this.options.clock.clearTimeout(timer);
    }
  }

  private settlePart(part: Part, end: number): void {
    part.end = end;
    part.settled = true;
  }

  private outcome(): ReplyOutcome {
    const parts: DeliveredPart[] = this.blocks.flatMap((state, block) =>
      state.parts.map((part) => ({
        block,
        text: part.sent,
        ...(part.receipt ? { receipt: part.receipt } : {}),
        state: part.unknown ? "unknown" : part.settled ? "settled" : "open",
        ...(part.diverged ? { diverged: true as const } : {}),
      })),
    );
    const accepted = parts.some((part) => part.receipt);
    // An unknown result ranks above a stop or any other failure: a caller that
    // decides whether to send again reads the status, and a second create could
    // show the text twice. An edit whose result nothing resolved leaves the
    // platform showing text that is not known.
    const unresolved = this.blocks.some((state) => state.parts.some((part) => part.uncertain));
    const status: ReplyOutcome["status"] =
      unresolved ||
      parts.some((part) => part.state === "unknown") ||
      this.failure?.kind === "unknown"
        ? "unknown"
        : this.abort.signal.aborted
          ? "stopped"
          : this.failure
            ? accepted
              ? "partial"
              : "failed"
            : "delivered";
    return {
      status,
      parts,
      ...(parts.some((part) => part.diverged) ? { diverged: true as const } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }
}

function sameTarget(
  fresh: Exclude<Plan, null>,
  planned: Exclude<Plan, null | { waitUntil: number }>,
): fresh is Exclude<Plan, null | { waitUntil: number }> {
  if (!("write" in fresh) || fresh.write !== planned.write || fresh.block !== planned.block)
    return false;
  return fresh.write === "edit"
    ? fresh.part === (planned as { part: Part }).part
    : fresh.start === (planned as { start: number }).start;
}

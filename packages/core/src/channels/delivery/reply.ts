import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { Clock, ClockTimer } from "../../lib/clock.js";
import { createLogger } from "../../logger.js";
import { ReplyAssembler } from "./assembler.js";
import { type Pacer, SKIPPED } from "./pacer.js";
import { lastBreak, splitPoint } from "./split.js";
import {
  asDeliveryFailure,
  type DeliveryFailure,
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
   * have happened. `stopped`: the run was stopped.
   */
  status: "delivered" | "partial" | "failed" | "unknown" | "stopped";
  parts: DeliveredPart[];
  failure?: { kind: DeliveryFailure["kind"] | "overflow"; message: string };
}

export interface ReplyOptions {
  transport: DeliveryTransport;
  /** The pacer of the account the transport writes as. */
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

/** Consecutive edits with an unknown result before the reply gives up. */
const MAX_UNKNOWN_EDITS = 3;

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
 *   last acknowledged, and only a successful edit settles it.
 * - A create whose result is unknown is never repeated: the reply stops
 *   writing and reports `unknown`.
 * - After `stop()`, nothing new is written. A write already running finishes
 *   and is reported.
 *
 * The run's events go to `accept()`. `finish()` closes the reply once the run
 * ends and resolves when every write has finished.
 */
export class ReplyDelivery {
  private readonly assembler = new ReplyAssembler();
  private readonly blocks: BlockState[] = [];
  private readonly abort = new AbortController();
  private mode: DeliveryMode;
  private conversation: string;
  private closed = false;
  private writing = false;
  private failure?: ReplyOutcome["failure"];
  private unknownEdits = 0;
  private sourceChars = 0;
  private settledChars = 0;
  private timer?: ClockTimer;
  private readonly idle: Array<() => void> = [];

  constructor(private readonly options: ReplyOptions) {
    this.mode = effectiveMode(options.policy, options.transport.capabilities);
    this.conversation = options.conversation;
  }

  /** Takes one event of the run. Events after `finish()` or `stop()` are ignored. */
  accept(event: StreamAgentEvent): void {
    if (this.closed || this.failure) return;
    this.sourceChars += this.assembler.apply(event);
    const waiting = this.sourceChars - this.settledChars;
    // A `final` reply waits for its end by design, so nothing bounds its text.
    if (this.mode !== "final" && waiting > this.options.policy.maxPendingChars)
      this.fail({ kind: "overflow", message: `${waiting} characters wait unsent` });
    this.pump();
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
    void this.options.pacer
      .run(
        this.conversation,
        async (): Promise<void | typeof SKIPPED> => {
          // The reply can change while a write waits its turn. Its text may
          // have grown, it may have failed, and the write may have become
          // unnecessary. Only a write for the same target runs, with the
          // latest text. A write that does not run costs the pacer nothing.
          if (this.failure) return SKIPPED;
          const fresh = this.planSafely(this.now(), true);
          if (!fresh || !sameTarget(fresh, plan)) return SKIPPED;
          return this.write(fresh);
        },
        this.abort.signal,
      )
      .catch((error: unknown) => {
        // A write the stop dropped before it ran: nothing happened.
        if (this.abort.signal.aborted) return;
        // Anything else escaped the write's own handling of the transport's
        // errors, such as a codec that throws. Left alone it would plan the
        // same write again, so the reply fails.
        const message = error instanceof Error ? error.message : String(error);
        log.warn("reply write failed outside the transport", { error: message });
        this.fail({ kind: "rejected", message });
      })
      .finally(() => {
        this.writing = false;
        this.pump();
      });
  }

  /** `plan`, where a fault in planning fails the reply instead of throwing
   *  into whoever fed it text, or into the pacer. */
  private planSafely(now: number, ignoreWaits = false): Plan {
    try {
      return this.plan(now, ignoreWaits);
    } catch (error) {
      this.fail({
        kind: "rejected",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The next write, or when to look again, or null when there is nothing
   *  to do until more text arrives. `now` decides waits; `ignoreWaits` plans
   *  as though every wait were over. */
  private plan(now: number, ignoreWaits = false): Plan {
    // Nothing is written before the reply finishes, so there is nothing to plan.
    if (this.mode === "final" && !this.closed) return null;
    const { codec, capabilities } = this.options.transport;
    const limit = capabilities.maxPartLength;
    for (const [index, block] of this.assembler.blocks.entries()) {
      const state = (this.blocks[index] ??= { parts: [] });
      const complete = block.complete || this.closed;

      for (const part of state.parts) {
        if (!part.settled || part.diverged || part.unknown) continue;
        const source = block.text.slice(part.start, part.end);
        if (source === part.sentSource && !part.uncertain) continue;
        const rendered = codec.render(source, true);
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
        return { write: "edit", block: index, part, end: part.end, source, settle: true };
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
            active.diverged = true;
            this.settlePart(active, active.start + active.sentSource.length);
          }
          break;
        }
        let end = start + splitPoint(remaining, limit, codec);
        // A message never gives back text it already shows to the next one.
        const shown = active ? active.start + active.sentSource.length : start;
        if (
          end < shown &&
          codec.measure(codec.render(block.text.slice(start, shown), true)) <= limit
        )
          end = shown;
        const settle = complete || end < block.text.length;
        const source = block.text.slice(start, end);
        // The split can choose a prefix with nothing visible in it, such as a
        // long run of spaces. It is passed over without a message, and the
        // visible rest starts the next part.
        if (!active && !codec.render(source, settle).trim()) {
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
          return { write: "edit", block: index, part: active, end, source, settle };
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
        const receipt = await transport.create(
          this.conversation,
          rendered,
          first ? this.options.replyTo : undefined,
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
      if (!transport.edit) throw new Error("unreachable: edit mode without edit");
      await transport.edit(part.receipt!, rendered);
      Object.assign(part, { sent: rendered, sentSource: plan.source, lastWriteAt: this.now() });
      delete part.uncertain;
      if (!part.settled) part.end = plan.end;
      if (plan.settle && !part.settled) this.settlePart(part, plan.end);
      this.unknownEdits = 0;
      report("accepted", partIndex);
    } catch (error) {
      const failure = asDeliveryFailure(error);
      report(failure.kind, partIndex);
      part.lastWriteAt = this.now();
      if (failure.kind === "unknown") part.uncertain = true;
      if (failure.kind === "unsupported") {
        // The platform will not edit: keep what it shows and carry on in blocks.
        this.mode = "blocks";
        if (!part.settled) this.settlePart(part, part.start + part.sentSource.length);
        return;
      }
      if (failure.kind === "unknown" && ++this.unknownEdits < MAX_UNKNOWN_EDITS) return;
      this.handle(failure);
    }
  }

  private handle(failure: DeliveryFailure): void {
    if (failure.kind === "rate-limited") {
      // A platform's answer does not say whose limit it hit, so the whole
      // account waits.
      this.options.pacer.pause(failure.retryAfterMs ?? 1000);
      return;
    }
    this.fail({ kind: failure.kind, message: failure.message });
  }

  private settlePart(part: Part, end: number): void {
    part.end = end;
    part.settled = true;
    this.settledChars += part.end - part.start;
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
    const status: ReplyOutcome["status"] = this.abort.signal.aborted
      ? "stopped"
      : parts.some((part) => part.state === "unknown") || this.failure?.kind === "unknown"
        ? "unknown"
        : this.failure
          ? accepted
            ? "partial"
            : "failed"
          : "delivered";
    return { status, parts, ...(this.failure ? { failure: this.failure } : {}) };
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

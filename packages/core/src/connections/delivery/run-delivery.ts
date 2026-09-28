import type { MessageReceipt } from "@rome-os/app-runtime";
import { AssistantTextAssembler, type AssistantTextBlock } from "../../core/assistant-text.js";
import { partBoundary } from "./parts.js";
import { DeliveryScheduler } from "./scheduler.js";
import {
  DeliveryFailure,
  type DeliveryAttempt,
  type DeliveryRepository,
  type DeliveryTarget,
  type TextTransport,
} from "./transport.js";

interface Part {
  start: number;
  end: number;
  revision: number;
  source: string;
  rendered: string;
  receipt: MessageReceipt;
  settled: boolean;
}

interface Block extends AssistantTextBlock {
  complete: boolean;
  parts: Part[];
  createdAt: number;
}

/** Owns a run, never an input. Updates replace snapshots while one writer performs transport work. */
export class RunDelivery {
  readonly assembly = new AssistantTextAssembler();
  private readonly blocks = new Map<number, Block>();
  private readonly abort = new AbortController();
  private writer?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private error?: unknown;
  private closed = false;
  private finalizing = false;
  private version = 0;
  private drainedVersion = -1;
  private nextCorrectionIx = -1;
  private readonly correctedSources = new Map<number, string>();
  private target: DeliveryTarget;
  private mode: TextTransport["profile"]["mode"];

  constructor(
    readonly runId: string,
    target: DeliveryTarget,
    private readonly transport: TextTransport,
    private readonly scheduler: DeliveryScheduler,
    private readonly repository: DeliveryRepository,
    private readonly reportRecordingError: (error: unknown) => void,
  ) {
    this.target = { ...target };
    this.mode = transport.profile.mode;
  }

  get receipts(): MessageReceipt[] {
    return [...this.blocks.values()].flatMap((block) => block.parts.map((part) => part.receipt));
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }
  get terminal(): boolean {
    return this.closed && !this.writer;
  }

  append(content: string, blockId?: string): void {
    if (this.closed) return;
    this.snapshot(this.assembly.append(content, blockId), false);
  }

  complete(content: string, phase?: AssistantTextBlock["turnPhase"], blockId?: string): void {
    if (this.closed) return;
    this.snapshot(this.assembly.complete(content, phase, blockId), true);
  }

  async finish(content: string): Promise<MessageReceipt[]> {
    if (!this.closed) {
      const final = this.assembly.final(content);
      if (final.content) this.snapshot(final, true);
      this.finalizing = true;
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.kick();
    }
    while (this.writer) await this.writer;
    if (this.abort.signal.aborted && !this.error) {
      throw new DeliveryFailure("failed", "Run output was stopped", this.receipts);
    }
    if (this.error) {
      const error = this.error;
      throw new DeliveryFailure(
        error instanceof DeliveryFailure ? error.kind : "unknown",
        error instanceof Error ? error.message : String(error),
        this.receipts,
      );
    }
    return this.receipts;
  }

  /** Closes admission synchronously. An in-flight accepted operation is still recorded. */
  async stop(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.writer;
  }

  private snapshot(snapshot: AssistantTextBlock, complete: boolean): void {
    this.version += 1;
    const old = this.blocks.get(snapshot.blockIx);
    this.blocks.set(snapshot.blockIx, {
      ...snapshot,
      complete,
      parts: old?.parts ?? [],
      createdAt: old?.createdAt ?? Date.now(),
    });
    const size = [...this.blocks.values()].reduce(
      (sum, block) => sum + Buffer.byteLength(block.content),
      0,
    );
    if (size > this.transport.profile.maxPendingBytes) {
      this.error = new DeliveryFailure("failed", "Run delivery memory bound exceeded");
      this.closed = true;
      this.abort.abort();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.kick();
  }

  private kick(): void {
    if (this.writer || this.timer || this.error || this.abort.signal.aborted) return;
    if (this.mode === "final" && !this.finalizing) return;
    let wait = 0;
    if (this.mode === "blocks" && !this.finalizing) {
      const age = Math.max(
        0,
        ...[...this.blocks.values()].map((block) => Date.now() - block.createdAt),
      );
      wait = Math.min(
        this.transport.profile.coalesceMs,
        Math.max(0, this.transport.profile.maxPendingAgeMs - age),
      );
    }
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.startWriter();
      }, wait);
      return;
    }
    this.startWriter();
  }

  private startWriter(): void {
    if (this.writer || this.error || this.abort.signal.aborted) return;
    // The writer re-reads each block after every await. No queued closure owns old text.
    this.writer = this.drain()
      .catch((error) => {
        if (!this.abort.signal.aborted) this.error = error;
      })
      .finally(() => {
        this.writer = undefined;
        if (this.drainedVersion !== this.version) {
          this.kick();
          return;
        }
        if (this.mode !== "blocks" || this.closed || this.error) return;
        const pending = [...this.blocks.values()].filter(
          (block) => !block.complete && (block.parts.at(-1)?.end ?? 0) < block.content.length,
        );
        if (!pending.length) return;
        const due = Math.min(
          ...pending.map((block) => block.createdAt + this.transport.profile.maxPendingAgeMs),
        );
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            this.startWriter();
          },
          Math.max(0, due - Date.now()),
        );
      });
  }

  private async drain(): Promise<void> {
    this.drainedVersion = this.version;
    for (const blockIx of this.blocks.keys()) {
      while (!this.abort.signal.aborted) {
        if (this.mode === "final" && !this.finalizing) return;
        const version = this.version;
        await this.reconcileCompletedParts(blockIx);
        if (version !== this.version) continue;
        if (this.mode === "final" && !this.finalizing) return;
        const block = this.blocks.get(blockIx)!;
        const part = block.parts.at(-1);
        const start = part && !part.settled ? part.start : (part?.end ?? 0);
        const remaining = block.content.slice(start);
        if (!remaining) break;
        const count = partBoundary(
          remaining,
          this.transport.profile.maxPartSize,
          this.transport.codec,
        );
        const end = start + count;
        const settle =
          block.complete ||
          count < remaining.length ||
          (this.mode === "blocks" &&
            Date.now() - block.createdAt >= this.transport.profile.maxPendingAgeMs);
        if (this.mode !== "edit" && !settle && !this.finalizing) break;
        const active = part && !part.settled ? part : undefined;
        const source = block.content.slice(start, end);
        const rendered = this.transport.codec.render(source, settle);
        if (active?.rendered === rendered && !settle) break;
        if (active?.rendered === rendered && settle) {
          active.settled = true;
          active.end = end;
          await this.record(block, active, "settle", "accepted");
          continue;
        }
        await this.submit(blockIx, start, end, !!active);
        const latest = this.blocks.get(blockIx)!;
        const current = latest.parts.at(-1);
        if (current && !current.settled && current.source === latest.content.slice(current.start))
          break;
      }
    }
  }

  private async reconcileCompletedParts(blockIx: number): Promise<void> {
    const block = this.blocks.get(blockIx)!;
    if (!block.complete) return;
    const last = block.parts.at(-1);
    const revised = block.parts.some(
      (part) => part.source !== block.content.slice(part.start, part.end),
    );
    if (!revised) return;
    const needsNewBoundaries = block.parts.some((part) => {
      const source = block.content.slice(part.start, part.end);
      return (
        part.start >= block.content.length ||
        /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(source) ||
        this.transport.codec.length(this.transport.codec.render(source, true)) >
          this.transport.profile.maxPartSize
      );
    });
    if (this.mode !== "edit" || !this.transport.update || needsNewBoundaries) {
      this.correct(block);
      return;
    }
    if (last) last.settled = false;
    for (const part of block.parts) {
      if (!part.settled) continue;
      const source = block.content.slice(part.start, part.end);
      if (part.source === source) continue;
      while (part.source !== this.blocks.get(blockIx)!.content.slice(part.start, part.end)) {
        this.abort.signal.throwIfAborted();
        await this.submit(blockIx, part.start, part.end, true, part);
        if (this.mode !== "edit") return;
      }
    }
  }

  private correct(block: Block): void {
    if (this.correctedSources.get(block.blockIx) !== block.content) {
      this.correctedSources.set(block.blockIx, block.content);
      const blockIx = this.nextCorrectionIx--;
      this.blocks.set(blockIx, {
        blockIx,
        content: `Correction:\n${block.content}`,
        complete: block.complete,
        parts: [],
        createdAt: Date.now(),
      });
    }
    // Correction identities cannot collide with provider-assigned block ordinals.
    block.content = block.parts.map((part) => part.source).join("");
  }

  private async submit(
    blockIx: number,
    start: number,
    end: number,
    update: boolean,
    fixedPart?: Part,
  ): Promise<void> {
    const transport = this.transport;
    const operation = update ? "update" : "create";
    try {
      await this.scheduler.run(
        transport.profile,
        this.target.conversationId,
        operation,
        () => transport.assertAuthorized(),
        async () => {
          const block = this.blocks.get(blockIx)!;
          const sourceTail = block.content.slice(start);
          end = fixedPart
            ? fixedPart.end
            : start + partBoundary(sourceTail, transport.profile.maxPartSize, transport.codec);
          const source = block.content.slice(start, end);
          const settled = block.complete || end < block.content.length || this.mode !== "edit";
          const rendered = transport.codec.render(source, settled);
          const part = update ? (fixedPart ?? block.parts.at(-1)!) : undefined;
          const revision = (part?.revision ?? 0) + 1;
          await this.repository.record({
            runId: this.runId,
            blockIx,
            partIx: part ? block.parts.indexOf(part) : block.parts.length,
            sourceStart: start,
            sourceEnd: end,
            revision,
            target: this.target,
            operation,
            outcome: "attempting",
            receipt: part?.receipt,
          });
          this.abort.signal.throwIfAborted();
          transport.assertAuthorized();
          let receipt: MessageReceipt;
          if (part && !transport.update)
            throw new DeliveryFailure("unsupported", "Text updates are unsupported");
          if (part) {
            await transport.update!(part.receipt, rendered);
            receipt = part.receipt;
          } else {
            receipt = await transport.create(this.target, rendered);
            this.target = { ...this.target, conversationId: receipt.conversationId };
          }
          const accepted: Part = { start, end, revision, source, rendered, receipt, settled };
          if (part) Object.assign(part, accepted);
          else block.parts.push(accepted);
          if (settled && !block.complete) block.createdAt = Date.now();
          // Accepted transport is never repeated because a local evidence write failed.
          await this.record(block, part ?? accepted, operation, "accepted");
          if (settled) await this.record(block, part ?? accepted, "settle", "accepted");
        },
        this.abort.signal,
      );
    } catch (error) {
      if (error instanceof DeliveryFailure && error.kind === "rate-limit") return;
      if (error instanceof DeliveryFailure && error.kind === "unsupported" && update) {
        this.mode = transport.profile.unsupportedMode;
        const block = this.blocks.get(blockIx)!;
        const part = fixedPart ?? block.parts.at(-1)!;
        part.settled = true;
        await this.record(block, part, "settle", "accepted");
        if (
          (this.mode !== "final" || this.finalizing) &&
          part.source !== block.content.slice(part.start, part.end)
        ) {
          this.correct(block);
        }
        return;
      }
      const block = this.blocks.get(blockIx)!;
      const part = update ? (fixedPart ?? block.parts.at(-1)) : undefined;
      if (
        part &&
        error instanceof DeliveryFailure &&
        error.kind === "unknown" &&
        transport.reconcile
      ) {
        const observed = await transport.reconcile(part.receipt);
        if (observed.quiescent) {
          part.rendered = observed.text;
          return;
        }
      }
      let outcome: DeliveryAttempt["outcome"] = "unknown";
      if (error instanceof DeliveryFailure && error.kind !== "unknown") outcome = "failed";
      if (this.abort.signal.aborted) outcome = "stopped";
      try {
        await this.repository.record({
          runId: this.runId,
          blockIx,
          partIx: part ? block.parts.indexOf(part) : block.parts.length,
          sourceStart: start,
          sourceEnd: end,
          revision: (part?.revision ?? 0) + 1,
          target: this.target,
          operation,
          outcome,
          receipt: part?.receipt,
        });
      } catch (recordError) {
        this.reportRecordingError(recordError);
      }
      throw error;
    }
  }

  private async record(
    block: Block,
    part: Part,
    operation: DeliveryAttempt["operation"],
    outcome: DeliveryAttempt["outcome"],
  ): Promise<void> {
    try {
      await this.repository.record({
        runId: this.runId,
        blockIx: block.blockIx,
        partIx: block.parts.indexOf(part),
        sourceStart: part.start,
        sourceEnd: part.end,
        revision: part.revision,
        target: this.target,
        operation,
        outcome,
        receipt: part.receipt,
      });
    } catch (error) {
      this.reportRecordingError(error);
    }
  }
}

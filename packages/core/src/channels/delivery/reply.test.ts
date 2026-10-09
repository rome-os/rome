import { beforeEach, describe, expect, it } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { FakeClock } from "../../test/kit/clock.js";
import { Pacer } from "./pacer.js";
import { type DeliveryEvent, ReplyDelivery } from "./reply.js";
import {
  DeliveryFailure,
  type DeliveryPolicy,
  type DeliveryTransport,
  type PartReceipt,
  plainText,
} from "./types.js";

const OPEN_BUDGET = { burst: 1000, refillMs: 1, conversationSpacingMs: 0 };

/** A platform in memory: what each message showed over time, and scripted failures. */
class MemoryPlatform implements DeliveryTransport {
  readonly codec = plainText;
  readonly messages: Array<{ id: string; replyTo?: string; history: string[] }> = [];
  /** Each fails the first matching write once `after` messages exist. */
  readonly failures: Array<{ write: "create" | "edit"; failure: DeliveryFailure; after?: number }> =
    [];
  /** Resolves the next create only when released, to model a slow platform. */
  hold?: Promise<void>;
  /** Refuses text with nothing visible in it, as Telegram does. */
  rejectBlank = false;
  readonly edit?: (receipt: PartReceipt, text: string) => Promise<void>;

  constructor(
    readonly capabilities = { maxPartLength: 20, edit: true, budget: OPEN_BUDGET },
    private readonly conversation = "c1",
  ) {
    if (capabilities.edit)
      this.edit = async (receipt, text) => {
        this.fail("edit");
        this.messages.find((m) => m.id === receipt.messageId)!.history.push(text);
      };
  }

  async create(_conversation: string, text: string, replyTo?: string): Promise<PartReceipt> {
    await this.hold;
    if (this.rejectBlank && !text.trim())
      throw new DeliveryFailure("rejected", "message text is empty");
    this.fail("create");
    const id = `m${this.messages.length + 1}`;
    this.messages.push({ id, ...(replyTo ? { replyTo } : {}), history: [text] });
    return { messageId: id, conversationId: this.conversation };
  }

  /** What each message shows now. */
  get shown(): string[] {
    return this.messages.map((m) => m.history.at(-1)!);
  }

  private fail(write: "create" | "edit") {
    const index = this.failures.findIndex(
      (f) => f.write === write && this.messages.length >= (f.after ?? 0),
    );
    if (index >= 0) throw this.failures.splice(index, 1)[0]!.failure;
  }
}

const delta = (content: string, blockId?: string): StreamAgentEvent => ({
  type: "text_delta",
  content,
  ...(blockId ? { blockId } : {}),
});
const text = (content: string, blockId?: string): StreamAgentEvent => ({
  type: "text",
  content,
  ...(blockId ? { blockId } : {}),
});
const result = (content: string): StreamAgentEvent => ({ type: "result", content });

describe("ReplyDelivery", () => {
  let clock: FakeClock;
  let platform: MemoryPlatform;
  let events: DeliveryEvent[];

  beforeEach(() => {
    clock = new FakeClock();
    platform = new MemoryPlatform();
    events = [];
  });

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const advance = async (ms: number) => {
    await settle();
    await clock.advance(ms);
  };

  const reply = (policy: Partial<DeliveryPolicy> = {}, transport: DeliveryTransport = platform) =>
    new ReplyDelivery({
      transport,
      pacer: new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock),
      policy: {
        mode: "edit",
        editIntervalMs: 1000,
        blockWaitMs: 2000,
        maxPendingChars: 10_000,
        ...policy,
      },
      conversation: "c1",
      replyTo: "u1",
      clock,
      observe: (event) => events.push(event),
    });

  /** Feeds `source` one word at a time, `gapMs` apart. */
  const stream = async (
    delivery: ReplyDelivery,
    source: string,
    gapMs: number,
    blockId?: string,
  ) => {
    for (const word of source.match(/\S+\s*/g) ?? []) {
      delivery.accept(delta(word, blockId));
      await advance(gapMs);
    }
  };

  describe("edit mode", () => {
    it("creates each of three parts once, updates each, and settles each", async () => {
      const delivery = reply();
      const source = "one two three four five six seven eight nine ten eleven twelve";
      await stream(delivery, source, 600, "b1");
      delivery.accept(text(source, "b1"));
      const finished = delivery.finish();
      // The last edits still keep editIntervalMs apart.
      await advance(10_000);
      const outcome = await finished;

      expect(outcome.status).toBe("delivered");
      expect(platform.messages.length).toBeGreaterThanOrEqual(3);
      expect(platform.shown.join("")).toBe(source);
      for (const message of platform.messages) {
        expect(message.history.length).toBeGreaterThan(1);
        // A message only ever grows: no write carries text older than it shows.
        for (const [i, shown] of message.history.entries())
          if (i > 0) expect(shown.startsWith(message.history[i - 1]!.trimEnd())).toBe(true);
      }
      expect(outcome.parts.every((part) => part.state === "settled")).toBe(true);
      expect(platform.messages.map((m) => m.replyTo)).toEqual([
        "u1",
        ...platform.messages.slice(1).map(() => undefined),
      ]);
    });

    it("streams a commentary and the answer as their own messages", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      await stream(delivery, "Looking it up.", 10, "c");
      delivery.accept(text("Looking it up.", "c"));
      await stream(delivery, "The answer is 42.", 10, "a");
      delivery.accept(text("The answer is 42.", "a"));
      delivery.accept(result("The answer is 42."));
      await delivery.finish();

      expect(platform.shown).toEqual(["Looking it up.", "The answer is 42."]);
      expect(platform.messages[1]!.history.length).toBeGreaterThan(1);
    });

    it("creates one message while its slow create is in flight, then edits it", async () => {
      let release!: () => void;
      platform.hold = new Promise((resolve) => (release = resolve));
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Hello"));
      await advance(0);
      delivery.accept(delta(" there"));
      delivery.accept(delta(" friend"));
      await advance(0);
      release();
      platform.hold = undefined;
      delivery.accept(text("Hello there friend"));
      await delivery.finish();

      expect(platform.messages).toHaveLength(1);
      expect(platform.shown).toEqual(["Hello there friend"]);
    });

    it("sends the latest text after a rate limit, never the previews that piled up", async () => {
      platform.failures.push({
        write: "edit",
        failure: new DeliveryFailure("rate-limited", "slow down", 5000),
      });
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("a"));
      await advance(0);
      for (const word of [" b", " c", " d", " e"]) {
        delivery.accept(delta(word));
        await advance(1000);
      }
      delivery.accept(text("a b c d e"));
      const finished = delivery.finish();
      await advance(10_000);
      await finished;

      const history = platform.messages[0]!.history;
      expect(history.at(-1)).toBe("a b c d e");
      // The edit after the pause carries the newest text, not each stale preview.
      expect(history.length).toBeLessThanOrEqual(3);
      expect(events.filter((e) => e.result === "rate-limited")).toHaveLength(1);
    });

    it("edits a settled part when the complete block revises it", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Draft text that goes past one part"));
      await advance(0);
      await advance(0);
      delivery.accept(text("Final text that goes past one part"));
      await delivery.finish();

      expect(platform.shown.join("")).toBe("Final text that goes past one part");
    });

    it("never moves text a preview already shows into the next message", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      // Twenty characters fill the part; a readable break lies at 14.
      delivery.accept(delta("one two three fourfi"));
      await advance(0);
      delivery.accept(delta("ve six"));
      delivery.accept(text("one two three fourfive six"));
      await delivery.finish();

      expect(platform.shown).toEqual(["one two three fourfi", "ve six"]);
      expect(platform.messages[0]!.history).toEqual(["one two three fourfi"]);
    });

    it("keeps Chinese and emoji whole within the limit", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      const source = "这是一个很长的回答😀，它需要被分成好几条消息才能发完。最后一句话在这里😀";
      await stream(delivery, source.split("").join(""), 0);
      delivery.accept(text(source));
      await delivery.finish();

      expect(platform.shown.join("")).toBe(source);
      for (const shown of platform.shown) {
        expect(shown.length).toBeLessThanOrEqual(20);
        expect(shown).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
    });

    it("falls back to separate messages when the platform refuses edits", async () => {
      platform.failures.push({
        write: "edit",
        failure: new DeliveryFailure("unsupported", "cannot edit"),
      });
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("first"));
      await advance(0);
      delivery.accept(delta(" second"));
      await advance(0);
      delivery.accept(text("first second"));
      const outcome = await delivery.finish();

      expect(platform.shown).toEqual(["first", " second"]);
      expect(outcome.status).toBe("delivered");
    });
  });

  describe("blocks mode", () => {
    it("sends a settled part at once and a waiting part after blockWaitMs", async () => {
      const delivery = reply({ mode: "blocks" });
      delivery.accept(delta("short start"));
      await advance(1000);
      expect(platform.messages).toHaveLength(0);
      await advance(1000);
      expect(platform.shown).toEqual(["short start"]);
      delivery.accept(delta(" and the rest"));
      delivery.accept(text("short start and the rest"));
      await delivery.finish();

      expect(platform.shown).toEqual(["short start", " and the rest"]);
      expect(platform.messages.every((m) => m.history.length === 1)).toBe(true);
    });

    it("is what edit mode becomes on a platform that cannot edit", async () => {
      const appendOnly = new MemoryPlatform({
        maxPartLength: 20,
        edit: false,
        budget: OPEN_BUDGET,
      });
      const delivery = reply({ mode: "edit" }, appendOnly);
      delivery.accept(text("A whole answer that needs two parts."));
      await delivery.finish();

      expect(appendOnly.shown.join("")).toBe("A whole answer that needs two parts.");
      expect(appendOnly.messages.every((m) => m.history.length === 1)).toBe(true);
    });

    it("reports a part that differs from the final text instead of resending it", async () => {
      const delivery = reply({ mode: "blocks", blockWaitMs: 0 });
      delivery.accept(delta("Draft"));
      await advance(0);
      await advance(0);
      delivery.accept(text("Final"));
      const outcome = await delivery.finish();

      expect(platform.shown).toEqual(["Draft"]);
      expect(outcome.parts).toEqual([expect.objectContaining({ text: "Draft", diverged: true })]);
    });
  });

  it("sends nothing in final mode until the reply finishes", async () => {
    const delivery = reply({ mode: "final" });
    await stream(delivery, "one two three", 5000);
    delivery.accept(text("one two three"));
    await advance(10_000);
    expect(platform.messages).toHaveLength(0);
    await delivery.finish();
    expect(platform.shown).toEqual(["one two three"]);
  });

  it("does not send the answer twice when the result repeats the last block", async () => {
    const delivery = reply({ mode: "blocks" });
    delivery.accept(text("The answer."));
    delivery.accept(result("The answer."));
    await delivery.finish();
    expect(platform.shown).toEqual(["The answer."]);
  });

  it("ignores thinking and tool events", async () => {
    const delivery = reply({ mode: "blocks" });
    delivery.accept({ type: "thinking", content: "secret plan" });
    delivery.accept({ type: "tool_use", id: "t1", tool: "search", input: {} });
    delivery.accept(result("Done."));
    await delivery.finish();
    expect(platform.shown).toEqual(["Done."]);
  });

  it("never repeats a create whose result is unknown", async () => {
    platform.failures.push({
      write: "create",
      failure: new DeliveryFailure("unknown", "timed out"),
    });
    const delivery = reply({ mode: "blocks" });
    delivery.accept(text("Something long enough for two parts."));
    const outcome = await delivery.finish();

    expect(platform.messages).toHaveLength(0);
    expect(events.filter((e) => e.write === "create")).toHaveLength(1);
    expect(outcome.status).toBe("unknown");
  });

  it("keeps the receipts of parts sent before a later part fails", async () => {
    platform.failures.push({
      write: "create",
      failure: new DeliveryFailure("rejected", "no"),
      after: 1,
    });
    const delivery = reply({ mode: "blocks" });
    delivery.accept(text("Something long enough for two parts."));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("partial");
    expect(outcome.parts).toEqual([
      expect.objectContaining({
        state: "settled",
        receipt: { messageId: "m1", conversationId: "c1" },
      }),
    ]);
    expect(outcome.failure).toEqual({ kind: "rejected", message: "no" });
  });

  it("writes nothing new after stop, and reports it stopped", async () => {
    const delivery = reply({ editIntervalMs: 1000 });
    delivery.accept(delta("Hello"));
    await advance(0);
    delivery.accept(delta(" more text"));
    const outcome = await delivery.stop();
    await advance(5000);

    expect(platform.shown).toEqual(["Hello"]);
    expect(outcome.status).toBe("stopped");
  });

  it("fails rather than holding more unsent text than its bound", async () => {
    const delivery = reply({ mode: "edit", maxPendingChars: 10 });
    delivery.accept(delta("more than ten characters"));
    const outcome = await delivery.finish();
    expect(outcome).toMatchObject({ status: "failed", failure: { kind: "overflow" } });
    expect(platform.messages).toHaveLength(0);
  });

  it("delivers a reply longer than the unsent-text bound in final mode, which waits by design", async () => {
    const delivery = reply({ mode: "final", maxPendingChars: 10 });
    delivery.accept(result("more than ten characters"));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(platform.shown.join("")).toBe("more than ten characters");
  });

  describe("text with nothing visible in it", () => {
    beforeEach(() => {
      platform.rejectBlank = true;
    });

    it("waits for visible text before it creates a message", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("\n\n", "a"));
      await advance(0);
      expect(platform.messages).toHaveLength(0);

      delivery.accept(delta("Hello", "a"));
      delivery.accept(text("\n\nHello", "a"));
      const outcome = await delivery.finish();

      expect(outcome.status).toBe("delivered");
      expect(platform.shown).toEqual(["\n\nHello"]);
    });

    it("writes nothing for a block that is only whitespace", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(text("  \n", "a"));
      const outcome = await delivery.finish();

      expect(platform.messages).toHaveLength(0);
      expect(outcome).toMatchObject({ status: "delivered", parts: [] });
    });

    it("drops a whitespace tail that a split leaves instead of sending it", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(text(`${"a".repeat(20)}\n`, "a"));
      const outcome = await delivery.finish();

      expect(platform.shown).toEqual(["a".repeat(20)]);
      expect(outcome.status).toBe("delivered");
    });

    it("waits in blocks mode too, however long its block has waited", async () => {
      const delivery = reply({ mode: "blocks", blockWaitMs: 0 });
      delivery.accept(delta(" ", "a"));
      await advance(0);
      await advance(0);
      expect(platform.messages).toHaveLength(0);

      delivery.accept(delta("x", "a"));
      delivery.accept(text(" x", "a"));
      const outcome = await delivery.finish();

      expect(outcome.status).toBe("delivered");
      expect(platform.shown).toEqual([" x"]);
    });
  });

  describe("a write that waits in a paced queue", () => {
    const paused = (policy: Partial<DeliveryPolicy> = {}) => {
      const pacer = new Pacer(OPEN_BUDGET, clock);
      pacer.pause(1000);
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: {
          mode: "edit",
          editIntervalMs: 0,
          blockWaitMs: 0,
          maxPendingChars: 10_000,
          ...policy,
        },
        conversation: "c1",
        clock,
      });
      return { pacer, delivery };
    };

    it("does not send a preview the reply no longer holds", async () => {
      const { delivery } = paused();
      delivery.accept(delta("Draft", "a"));
      delivery.accept(text("", "a"));
      const finished = delivery.finish();
      await advance(2000);
      const outcome = await finished;

      expect(platform.messages).toHaveLength(0);
      expect(outcome).toMatchObject({ status: "delivered", parts: [] });
    });

    it("does not send once the reply has failed", async () => {
      const { delivery } = paused({ maxPendingChars: 10 });
      delivery.accept(delta("small", "a"));
      delivery.accept(delta(" too much", "a"));
      const finished = delivery.finish();
      await advance(2000);
      const outcome = await finished;

      expect(platform.messages).toHaveLength(0);
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "overflow" } });
    });

    it("still sends the latest text when only the text changed", async () => {
      const { delivery } = paused();
      delivery.accept(delta("Draft", "a"));
      delivery.accept(delta(" and more", "a"));
      const finished = delivery.finish();
      await advance(2000);
      await finished;

      expect(platform.shown).toEqual(["Draft and more"]);
    });
  });

  it("pauses every conversation of the account when the platform rate-limits one", async () => {
    const pacer = new Pacer(OPEN_BUDGET, clock);
    platform.failures.push({
      write: "create",
      failure: new DeliveryFailure("rate-limited", "slow down", 5000),
    });
    const delivery = new ReplyDelivery({
      transport: platform,
      pacer,
      policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      conversation: "c1",
      clock,
    });
    delivery.accept(result("hi"));
    await advance(0);

    let otherRan = false;
    void pacer.run("c2", async () => {
      otherRan = true;
    });
    await advance(4000);
    expect(otherRan).toBe(false);

    const finished = delivery.finish();
    await advance(2000);
    await finished;
    expect(otherRan).toBe(true);
    expect(platform.shown).toEqual(["hi"]);
  });

  it("fails the reply instead of planning the same write again when a write fails outside the transport", async () => {
    // Stands in for a fault the write's own handling of the transport's errors
    // does not cover, such as a codec that throws.
    const faulty = {
      run: async () => {
        throw new Error("codec exploded");
      },
      pause: () => {},
    } as unknown as Pacer;
    const delivery = new ReplyDelivery({
      transport: platform,
      pacer: faulty,
      policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      conversation: "c1",
      clock,
    });
    delivery.accept(result("hi"));
    const outcome = await delivery.finish();

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { kind: "rejected", message: "codec exploded" },
    });
  });

  it("keeps a delivered message delivered when the observer throws", async () => {
    const delivery = new ReplyDelivery({
      transport: platform,
      pacer: new Pacer(OPEN_BUDGET, clock),
      policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      conversation: "c1",
      clock,
      // Throws only for an accepted write, so a faulty hook cannot also fail
      // the failure path and hide what it did to the outcome.
      observe: (event) => {
        if (event.result === "accepted") throw new Error("observer");
      },
    });
    delivery.accept(result("hi"));
    const outcome = await delivery.finish();

    expect(outcome).toMatchObject({ status: "delivered" });
    expect(platform.messages).toHaveLength(1);
  });

  it("fails the reply, and never throws into its caller, when it cannot split text", async () => {
    const unsplittable = new MemoryPlatform({ maxPartLength: 0, edit: true, budget: OPEN_BUDGET });
    const delivery = reply({}, unsplittable);

    expect(() => delivery.accept(delta("hello"))).not.toThrow();
    const outcome = await delivery.finish();

    expect(outcome).toMatchObject({
      status: "failed",
      failure: { kind: "rejected", message: expect.stringContaining("one character") },
    });
  });
});

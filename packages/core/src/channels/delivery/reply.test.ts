import { beforeEach, describe, expect, it } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { FakeClock } from "../../test/kit/clock.js";
import { Outlasted, Pacer } from "./pacer.js";
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
  /** Holds each edit until released, to model one still in flight. */
  editGate?: Promise<void>;
  /** The next edits are applied and then answer as lost, so their result is unknown. */
  lostEditAnswers = 0;
  /** A failure the first edit after the next lost answer meets. */
  afterLostAnswer?: DeliveryFailure;
  readonly edit?: (receipt: PartReceipt, text: string) => Promise<void>;

  constructor(
    readonly capabilities = { maxPartLength: 20, edit: true, budget: OPEN_BUDGET },
    private readonly conversation = "c1",
  ) {
    if (capabilities.edit)
      this.edit = async (receipt, text) => {
        await this.editGate;
        if (this.rejectBlank && !text.trim())
          throw new DeliveryFailure("rejected", "message text is empty");
        this.fail("edit");
        this.messages.find((m) => m.id === receipt.messageId)!.history.push(text);
        if (this.lostEditAnswers > 0) {
          this.lostEditAnswers -= 1;
          if (this.afterLostAnswer) {
            this.failures.push({ write: "edit", failure: this.afterLostAnswer });
            this.afterLostAnswer = undefined;
          }
          throw new DeliveryFailure("unknown", "the answer was lost");
        }
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
    it("sends a waiting part after blockWaitMs, ending at a break, and the rest once the block completes", async () => {
      const delivery = reply({ mode: "blocks" });
      delivery.accept(delta("First idea. Second"));
      await advance(1000);
      expect(platform.messages).toHaveLength(0);
      await advance(1000);
      expect(platform.shown).toEqual(["First idea."]);
      delivery.accept(delta(" idea"));
      delivery.accept(text("First idea. Second idea"));
      await delivery.finish();

      expect(platform.shown).toEqual(["First idea.", " Second idea"]);
      expect(platform.messages.every((m) => m.history.length === 1)).toBe(true);
    });

    it("never ends a part that waited out blockWaitMs in the middle of a word", async () => {
      const delivery = reply({ mode: "blocks", blockWaitMs: 1000 });
      delivery.accept(delta("Hello wor", "a"));
      await advance(1500);
      expect(platform.shown).toEqual(["Hello "]);

      delivery.accept(delta("ld, bye", "a"));
      delivery.accept(text("Hello world, bye", "a"));
      await delivery.finish();
      expect(platform.shown).toEqual(["Hello ", "world, bye"]);
    });

    it("keeps waiting while the text holds no break, and sends at once when one arrives", async () => {
      const delivery = reply({ mode: "blocks", blockWaitMs: 1000 });
      delivery.accept(delta("Hel", "a"));
      await advance(5000);
      expect(platform.messages).toHaveLength(0);

      delivery.accept(delta("lo wor", "a"));
      await advance(0);
      expect(platform.shown).toEqual(["Hello "]);
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
      delivery.accept(delta("Draft. "));
      await advance(0);
      await advance(0);
      delivery.accept(text("Final. "));
      const outcome = await delivery.finish();

      expect(platform.shown).toEqual(["Draft."]);
      expect(outcome.parts).toEqual([expect.objectContaining({ text: "Draft.", diverged: true })]);
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

  it("reports a create whose result is unknown as unknown, even when the reply was stopped", async () => {
    // The create is in flight when the stop comes, and its answer is lost.
    let release!: () => void;
    platform.hold = new Promise((resolve) => (release = resolve));
    platform.failures.push({
      write: "create",
      failure: new DeliveryFailure("unknown", "the answer was lost"),
    });
    const delivery = reply({ editIntervalMs: 0 });
    delivery.accept(delta("Hello"));
    await advance(0);
    const stopping = delivery.stop();
    release();
    platform.hold = undefined;
    const outcome = await stopping;

    // A caller that decides whether to send again reads the status, and a second
    // create could show the text twice.
    expect(outcome.status).toBe("unknown");
    expect(outcome.parts).toEqual([expect.objectContaining({ state: "unknown" })]);
  });

  it("refuses a policy whose unsent-text bound cannot hold one message", () => {
    // The platform's limit is 20, so a bound of 20 fails while the first message fills.
    expect(() => reply({ mode: "edit", maxPendingChars: 20 })).toThrow(/maxPendingChars/);
    expect(() => reply({ mode: "blocks", maxPendingChars: 5 })).toThrow(/maxPendingChars/);
    // A final reply waits by design and has no bound.
    expect(() => reply({ mode: "final", maxPendingChars: 5 })).not.toThrow();
  });

  it("fails rather than holding more unsent text than its bound", async () => {
    const delivery = reply({ mode: "edit", maxPendingChars: 30 });
    delivery.accept(delta("more than thirty characters, which goes past it"));
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

    it("passes over a prefix a split chooses when it holds nothing visible, and sends the rest", async () => {
      // A limit of 20 makes the split end the first part inside the run of spaces.
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(text(`${" ".repeat(20)}hello`, "a"));
      const outcome = await delivery.finish();

      expect(platform.shown).toEqual(["hello"]);
      expect(outcome.status).toBe("delivered");
    });

    it("passes over a blank prefix that ends at a paragraph break", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(text(`${" ".repeat(12)}\n\n${"x".repeat(10)}`, "a"));
      const outcome = await delivery.finish();

      expect(platform.shown).toEqual(["x".repeat(10)]);
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
      const { delivery } = paused({ maxPendingChars: 30 });
      delivery.accept(delta("small", "a"));
      delivery.accept(delta(" and more than the bound lets wait", "a"));
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

  describe("an edit whose result is unknown", () => {
    /** Starts an edit to "Hello world" and holds it in flight, then completes the block back to "Hello". */
    const reviseBackWhileAnEditIsInFlight = async (delivery: ReplyDelivery) => {
      delivery.accept(delta("Hello", "a"));
      await advance(0);
      let release!: () => void;
      platform.editGate = new Promise<void>((resolve) => (release = resolve));
      delivery.accept(delta(" world", "a"));
      await advance(0);
      delivery.accept(text("Hello", "a"));
      platform.editGate = undefined;
      release();
    };

    it("is edited again before the part counts as settled, even when the text matches what was last acknowledged", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      platform.lostEditAnswers = 1;
      await reviseBackWhileAnEditIsInFlight(delivery);
      const outcome = await delivery.finish();

      // The lost edit changed the platform to "Hello world". Only a second edit puts "Hello" back.
      expect(platform.shown).toEqual(["Hello"]);
      expect(outcome.status).toBe("delivered");
      expect(outcome.parts).toEqual([expect.objectContaining({ text: "Hello", state: "settled" })]);
    });

    it.each([
      ["is not supported", new DeliveryFailure("unsupported", "the platform will not edit")],
      ["is refused", new DeliveryFailure("rejected", "message can't be edited")],
      [
        "meets a rate limit the reply will not wait out",
        new DeliveryFailure("rate-limited", "slow down", 3_600_000),
      ],
    ])("reports the reply as unknown when the edit that reconciles it %s", async (_, failure) => {
      const delivery = reply({ editIntervalMs: 0 });
      platform.lostEditAnswers = 1;
      platform.afterLostAnswer = failure;
      await reviseBackWhileAnEditIsInFlight(delivery);
      const outcome = await delivery.finish();

      // The platform may show "Hello world", and nothing put "Hello" back.
      expect(outcome.status).toBe("unknown");
      expect(outcome.parts).toEqual([expect.objectContaining({ text: "Hello" })]);
    });

    it("does not create the rest of the text again when edits become unsupported after a lost one", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Hello", "a"));
      await advance(0);
      platform.lostEditAnswers = 1;
      platform.afterLostAnswer = new DeliveryFailure("unsupported", "the platform will not edit");
      delivery.accept(delta(" world", "a"));
      const outcome = await delivery.finish();

      // The platform may already show "Hello world", so a create of " world" would show it twice.
      expect(outcome.status).toBe("unknown");
      expect(platform.messages).toHaveLength(1);
    });

    it("reports the reply as unknown when the edit that reconciles it is lost too", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      platform.lostEditAnswers = 3;
      await reviseBackWhileAnEditIsInFlight(delivery);
      const outcome = await delivery.finish();

      expect(outcome.status).toBe("unknown");
    });
  });

  describe("an edit whose result is unknown, met by later text", () => {
    /** Holds an edit to "Hello world" in flight, and returns a way to let it through. */
    const holdAnEditInFlight = async (delivery: ReplyDelivery) => {
      delivery.accept(delta("Hello", "a"));
      await advance(0);
      let release!: () => void;
      platform.editGate = new Promise<void>((resolve) => (release = resolve));
      platform.lostEditAnswers = 1;
      delivery.accept(delta(" world", "a"));
      await advance(0);
      return () => {
        platform.editGate = undefined;
        release();
      };
    };

    it("reports the reply as unknown when the block completes blank, since the edit may show", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      const release = await holdAnEditInFlight(delivery);
      delivery.accept(text("", "a"));
      release();
      const outcome = await delivery.finish();

      // The platform shows "Hello world", and a blank edit cannot put anything back.
      expect(platform.shown).toEqual(["Hello world"]);
      expect(outcome.status).toBe("unknown");
    });

    it("never cuts a later part before text the lost edit may have put on the platform", async () => {
      const narrow = new MemoryPlatform({ maxPartLength: 12, edit: true, budget: OPEN_BUDGET });
      const delivery = reply({ editIntervalMs: 0 }, narrow);
      delivery.accept(delta("Hello", "a"));
      await advance(0);
      let release!: () => void;
      narrow.editGate = new Promise<void>((resolve) => (release = resolve));
      narrow.lostEditAnswers = 1;
      delivery.accept(delta(" world", "a"));
      await advance(0);
      // While the edit is in flight, the block grows past the limit with its only break early on.
      delivery.accept(delta("!and more", "a"));
      narrow.editGate = undefined;
      release();
      delivery.accept(text("Hello world!and more", "a"));
      await delivery.finish();

      const lengths = narrow.messages[0]!.history.map((shown) => shown.length);
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    });
  });

  it("keeps a preview, reported as differing, and goes on to the visible text when a split chooses a blank prefix", async () => {
    // The block completes as 20 spaces and "world", where a preview "Hello" is shown.
    platform.rejectBlank = true;
    const delivery = reply({ editIntervalMs: 0 });
    delivery.accept(delta("Hello", "a"));
    await advance(0);
    delivery.accept(text(`${" ".repeat(20)}world`, "a"));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(platform.shown.map((shown) => shown.trim())).toEqual(["Hello", "world"]);
    expect(outcome.parts[0]).toMatchObject({ text: "Hello", diverged: true });
  });

  describe("a platform that keeps rate-limiting", () => {
    const limited = (retryAfterMs: number, times: number) => {
      for (let i = 0; i < times; i++)
        platform.failures.push({
          write: "create",
          failure: new DeliveryFailure("rate-limited", "slow down", retryAfterMs),
        });
    };

    it("fails the reply when a single wait is longer than it will hold a reply for", async () => {
      limited(3_600_000, 1);
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(result("Hello"));
      const outcome = await delivery.finish();

      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });
      expect(platform.messages).toHaveLength(0);
    });

    /** A reply that shares its account's pacer with a write the test makes elsewhere. */
    const onSharedPacer = () => {
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        conversation: "c1",
        clock,
      });
      return { pacer, delivery };
    };

    it("still pauses the account for a limit it gave up on, whichever conversation writes next", async () => {
      limited(120_000, 1);
      const { pacer, delivery } = onSharedPacer();
      delivery.accept(result("Hello"));
      const outcome = await delivery.finish();
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });

      // Another conversation of the account, and the caller's whole send. The
      // platform named the window, so each waits it out.
      let other = false;
      const elsewhere = pacer.run("c2", async () => {
        other = true;
      });
      await advance(60_000);
      expect(other).toBe(false);
      await advance(61_000);
      await elsewhere;
      expect(other).toBe(true);
    });

    it("pauses the account for the wait that exhausted the allowance, when waits add up", async () => {
      limited(30_000, 5);
      const { pacer, delivery } = onSharedPacer();
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      // Two waits are held, and the third would pass the allowance at the 60 s mark.
      await advance(60_000);
      const outcome = await finished;
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });

      let other = false;
      const elsewhere = pacer.run("c2", async () => {
        other = true;
      });
      await advance(20_000);
      expect(other).toBe(false);
      await advance(15_000);
      await elsewhere;
      expect(other).toBe(true);
    });

    it("fails the reply when the account's queue holds its write for longer than a minute", async () => {
      // Another reply of the account got an hour's wait, which pauses every write.
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      pacer.pause(3_600_000);
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        conversation: "c1",
        clock,
      });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(61_000);
      await settle();

      const outcome = await Promise.race([finished, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });
      expect(platform.messages).toHaveLength(0);
    });

    it("reports a write held by its own conversation as unavailable, not as a rate limit", async () => {
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      // An earlier call for this conversation is still running, past what its caller waited for.
      await pacer.run("c1", async () => new Outlasted(new Promise<void>(() => {})));
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        conversation: "c1",
        clock,
      });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(61_000);
      await settle();

      const outcome = await Promise.race([finished, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      // No pause is in effect, so waiting out a limit would not help. The write never started.
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
      expect(platform.messages).toHaveLength(0);
    });

    it("fails the reply when another write's wait starts after its own write is queued", async () => {
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      let release = () => {};
      void pacer.run("c2", () => new Promise<void>((resolve) => (release = resolve)));
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        conversation: "c1",
        clock,
      });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await settle();
      // The write that runs ahead of it ends, and its platform answers with an hour's wait.
      pacer.pause(3_600_000);
      release();
      await advance(61_000);
      await settle();

      const outcome = await Promise.race([finished, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });
    });

    it("keeps a write that waits behind its own limit of a minute", async () => {
      limited(60_000, 1);
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(70_000);

      expect((await finished).status).toBe("delivered");
    });

    it("fails the reply when its waits add up past what it will hold a reply for", async () => {
      limited(30_000, 5);
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(200_000);
      const outcome = await finished;

      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });
    });

    it("still waits out a limit that is short enough, and delivers", async () => {
      limited(5_000, 1);
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(10_000);

      expect((await finished).status).toBe("delivered");
      expect(platform.shown).toEqual(["Hello"]);
    });
  });

  it("fails, and does not report unknown, when the platform could not be reached", async () => {
    // A write that certainly did not arrive may be sent again, so a caller can send the reply whole.
    platform.failures.push({
      write: "create",
      failure: new DeliveryFailure("unavailable", "getaddrinfo ENOTFOUND"),
    });
    const delivery = reply({ editIntervalMs: 0 });
    delivery.accept(result("Hello"));
    const outcome = await delivery.finish();

    expect(outcome).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
    expect(outcome.parts).toEqual([]);
    expect(platform.messages).toHaveLength(0);
  });

  it("settles a preview as shown, and reports it differing, when its block completes with nothing visible", async () => {
    const delivery = reply({ editIntervalMs: 0 });
    delivery.accept(delta("Hello", "a"));
    await advance(0);
    delivery.accept(text("", "a"));
    const outcome = await delivery.finish();

    expect(platform.shown).toEqual(["Hello"]);
    expect(outcome.parts).toEqual([
      expect.objectContaining({ text: "Hello", state: "settled", diverged: true }),
    ]);
    // The outcome says so too, so a caller need not scan the parts.
    expect(outcome.diverged).toBe(true);
  });

  it("keeps a settled part's message, reported as differing, when a shorter final text leaves nothing at its place", async () => {
    // Three parts are written from the deltas, then the complete block holds only the first.
    const narrow = new MemoryPlatform({ maxPartLength: 10, edit: true, budget: OPEN_BUDGET });
    const delivery = reply({ editIntervalMs: 0 }, narrow);
    delivery.accept(delta("aaaa bbbb cccc dddd eeee ffff", "a"));
    await advance(1000);
    expect(narrow.messages.length).toBeGreaterThanOrEqual(3);
    delivery.accept(text("aaaa", "a"));
    const outcome = await delivery.finish();

    // A blank edit would be refused and end the reply. The messages stay as they are.
    expect(outcome.failure).toBeUndefined();
    expect(outcome.status).toBe("delivered");
    expect(outcome.parts.slice(1).every((part) => part.diverged === true)).toBe(true);
    expect(outcome.diverged).toBe(true);
  });

  it("does not report a faithful reply as differing", async () => {
    const delivery = reply({ editIntervalMs: 0 });
    delivery.accept(result("Hello"));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(outcome.diverged).toBeUndefined();
  });

  describe("a write the platform does not answer", () => {
    const never = new Promise<void>(() => {});

    it("lets stop() return within the write deadline, reporting the create unknown", async () => {
      platform.hold = never;
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Hello"));
      await advance(0);
      const stopping = delivery.stop();
      await advance(30_000);
      await settle();

      const outcome = await Promise.race([stopping, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      // A second create could show the text twice, so the reply never repeats it.
      expect(outcome).toMatchObject({ status: "unknown", failure: { kind: "unknown" } });
      expect(platform.messages).toHaveLength(0);
    });

    it("lets finish() return within the write deadline, without writing the edit again", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Hello"));
      await advance(0);
      platform.editGate = never;
      delivery.accept(delta(" there"));
      await advance(0);
      const finished = delivery.finish();
      await advance(30_000);
      await settle();

      const outcome = await Promise.race([finished, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      expect(outcome).toMatchObject({ status: "unknown", failure: { kind: "unknown" } });
      expect(events.filter((event) => event.result === "unknown")).toHaveLength(1);
    });

    it("ignores the answer that arrives after the deadline", async () => {
      let release!: () => void;
      platform.hold = new Promise<void>((resolve) => (release = resolve));
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Hello"));
      await advance(0);
      const finished = delivery.finish();
      await advance(30_000);
      const outcome = await finished;
      release();
      platform.hold = undefined;
      await advance(5000);

      expect(outcome.status).toBe("unknown");
      // The late create reached the platform, but the reply had already given up on it.
      expect(events.filter((event) => event.result === "accepted")).toHaveLength(0);
    });
  });

  it("leaves the reply's state alone when it plans again as a write's turn comes", async () => {
    // The pacer is busy, so the second block's create waits in the queue with the reply writing.
    const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
    let release = () => {};
    const delivery = new ReplyDelivery({
      transport: platform,
      pacer,
      policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      conversation: "c1",
      clock,
    });
    delivery.accept(delta("Hello there my friend, nice day", "a"));
    delivery.accept(text("Hello there my friend, nice day", "a"));
    await advance(0);
    await advance(0);
    void pacer.run("c1", () => new Promise<void>((resolve) => (release = resolve)));
    delivery.accept(delta("Second", "b"));
    await settle();
    // The first block is revised to nothing visible, which a plan notes as parts
    // that differ. The reply is still writing, so nothing has planned since.
    delivery.accept(text("", "a"));

    type Probe = {
      planSafely(now: number, ignoreWaits: boolean, dry: boolean): unknown;
      blocks: Array<{ parts: Array<{ diverged?: true }> }>;
    };
    const probe = delivery as unknown as Probe;
    const differing = () => probe.blocks[0]!.parts.filter((part) => part.diverged).length;
    expect(differing()).toBe(0);
    // Planning as the pacer's job does, when its turn comes, changes nothing.
    probe.planSafely(clock.now().getTime(), true, true);
    expect(differing()).toBe(0);
    // Planning for real notes the parts.
    probe.planSafely(clock.now().getTime(), false, false);
    expect(differing()).toBeGreaterThan(0);

    release();
    await delivery.finish();
  });

  it("keeps the conversation's later writes behind a create the reply stopped waiting for", async () => {
    const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
    let release!: () => void;
    platform.hold = new Promise<void>((resolve) => (release = resolve));
    const delivery = new ReplyDelivery({
      transport: platform,
      pacer,
      policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      conversation: "c1",
      clock,
    });
    delivery.accept(delta("Hello"));
    await advance(0);
    const finished = delivery.finish();
    await advance(30_000);
    expect((await finished).status).toBe("unknown");

    // A write for the same conversation, asked for after the reply gave up on its create.
    const seen: number[] = [];
    const later = pacer.run("c1", async () => {
      seen.push(platform.messages.length);
    });
    await advance(0);
    await settle();
    expect(seen).toEqual([]);

    release();
    platform.hold = undefined;
    await later;
    // The create ended first, so the later write does not come before it.
    expect(seen).toEqual([1]);
  });

  it("fails the reply, and never throws into its caller, when the codec breaks while the layout is checked", async () => {
    let broken = false;
    const transport: DeliveryTransport = {
      codec: {
        ...plainText,
        render: (value, settled) => {
          if (broken) throw new Error("render broke");
          return plainText.render(value, settled);
        },
      },
      capabilities: platform.capabilities,
      create: (...args) => platform.create(...args),
      edit: platform.edit,
    };
    const delivery = reply({ editIntervalMs: 0 }, transport);
    // The spaces are passed over, and the rest becomes a visible message.
    delivery.accept(delta(`${" ".repeat(30)}hello world and more text`, "a"));
    await advance(0);
    expect(platform.messages.length).toBeGreaterThan(0);

    broken = true;
    expect(() => delivery.accept(delta(" and more", "a"))).not.toThrow();
    const outcome = await delivery.finish();

    expect(outcome.failure).toMatchObject({ kind: "internal" });
  });

  describe("boundaries kept from the streamed text", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it("never splits a surrogate pair when the final text moves a kept boundary into one", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      // A leading space and 19 letters fill the first message, so "😀b" starts the second.
      delivery.accept(delta(` ${"a".repeat(19)}😀b`, "a"));
      await advance(0);
      await advance(0);
      // The complete block has no leading space, which puts the emoji across the boundary.
      delivery.accept(text(`${"a".repeat(19)}😀b`, "a"));
      const outcome = await delivery.finish();

      expect(platform.shown.some((shown) => lone.test(shown))).toBe(false);
      expect(platform.shown.join("")).toBe(`${"a".repeat(19)}😀b`);
      expect(outcome.status).toBe("delivered");
    });

    it("counts text that a final text made visible among the unsent text, whatever was passed over", async () => {
      // The pacer is busy, so the first message waits in the queue.
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      let release = () => {};
      void pacer.run("c1", () => new Promise<void>((resolve) => (release = resolve)));
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 40 },
        conversation: "c1",
        clock,
      });
      // The split passes over 20 spaces and plans the rest.
      delivery.accept(delta(`${" ".repeat(30)}hello`, "a"));
      await settle();
      // The complete block is 60 letters, all of them visible and all of them unsent.
      delivery.accept(text("a".repeat(60), "a"));
      release();
      const outcome = await delivery.finish();

      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "overflow" } });
    });
  });

  describe("text a split passed over because it was blank", () => {
    // Thirty spaces in front of letters: the first split ends inside the spaces, so nothing is sent for them.
    const spaces = " ".repeat(30);
    const visible = (value: string) => value.replace(/\s/g, "");

    it("sends it when the block's final text makes it visible while the first message waits its turn", async () => {
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      let release = () => {};
      const ahead = pacer.run("c1", () => new Promise<void>((resolve) => (release = resolve)));
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
        conversation: "c1",
        clock,
      });
      // The spaces are passed over and the first message is planned at the b's, but it waits behind another write.
      delivery.accept(delta(`${spaces}${"b".repeat(25)}`, "a"));
      await settle();
      // The complete block drops the spaces, so the b's move up into the passed-over place.
      delivery.accept(text("b".repeat(25), "a"));
      release();
      await ahead;
      const outcome = await delivery.finish();

      expect(outcome.status).toBe("delivered");
      expect(visible(platform.shown.join(""))).toBe("b".repeat(25));
    });

    it("reports the message after it as differing when the final text makes it visible between messages", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      // The first message takes the letters and five spaces. The next 25 spaces are passed over,
      // and the second message starts at the b's.
      const tail = "c".repeat(15);
      delivery.accept(delta(`${"a".repeat(15)}${spaces}${"b".repeat(25)}${tail}`, "a"));
      await advance(1000);
      expect(platform.messages.length).toBeGreaterThanOrEqual(3);
      // The complete block is ten characters shorter in front and ten longer behind, so the b's move
      // into the passed-over place and every message still has text at its place.
      const final = `${"a".repeat(5)}${spaces}${"b".repeat(25)}${tail}${"d".repeat(10)}`;
      delivery.accept(text(final, "a"));
      const outcome = await delivery.finish();

      // A message cannot be put in front of the one that exists, so either everything
      // shows or the reply says it differs. It never claims a faithful delivery with text missing.
      const complete = visible(platform.shown.join("")) === visible(final);
      expect(complete || outcome.parts.some((part) => part.diverged === true)).toBe(true);
    });
  });

  it("keeps a reply's pacer lane when the platform reports another conversation id after the first create", async () => {
    const pacer = new Pacer({ ...OPEN_BUDGET, conversationSpacingMs: 1000 }, clock);
    const delivery = new ReplyDelivery({
      transport: platform,
      pacer,
      policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 10_000 },
      conversation: "@channel",
      clock,
    });
    delivery.accept(delta("Hello", "a"));
    await advance(100);
    delivery.accept(delta(" world", "a"));
    await advance(100);
    // The platform named the chat "c1" in its receipt, but the pacer still knows one lane.
    expect(pacer.size).toBe(1);
    const finished = delivery.finish();
    await advance(5000);
    await finished;
  });

  it("does not count text a split passed over, or a whitespace tail, as unsent", async () => {
    // Each block carries 25 spaces that are never sent. With them counted, 50 characters would wait.
    const delivery = reply({ editIntervalMs: 0, maxPendingChars: 40 });
    delivery.accept(text(`${" ".repeat(25)}hello`, "a"));
    await advance(100);
    delivery.accept(text(`${" ".repeat(25)}world`, "b"));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(platform.shown.map((shown) => shown.trim())).toEqual(["hello", "world"]);
  });

  it("falls back to blocks, instead of reporting unknown, when a transport declares edits and has none", async () => {
    const lying: DeliveryTransport = Object.create(platform, { edit: { value: undefined } });
    const delivery = reply({ editIntervalMs: 0 }, lying);
    delivery.accept(delta("Hello", "a"));
    await advance(100);
    delivery.accept(delta(" world", "a"));
    delivery.accept(text("Hello world", "a"));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(platform.shown.join("")).toBe("Hello world");
  });

  it("does no planning work for a final reply until it finishes", async () => {
    let renders = 0;
    const counting: DeliveryTransport = Object.create(platform, {
      codec: {
        value: {
          render: (source: string) => {
            renders += 1;
            return source;
          },
          measure: (rendered: string) => rendered.length,
        },
      },
    });
    const delivery = reply({ mode: "final" }, counting);
    for (let i = 0; i < 50; i++) delivery.accept(delta("word ", "a"));
    await advance(0);
    expect(renders).toBe(0);

    delivery.accept(text("word ".repeat(50), "a"));
    const outcome = await delivery.finish();
    expect(outcome.status).toBe("delivered");
    expect(renders).toBeGreaterThan(0);
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
      failure: { kind: "internal", message: "codec exploded" },
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
      failure: { kind: "internal", message: expect.stringContaining("one character") },
    });
  });
});

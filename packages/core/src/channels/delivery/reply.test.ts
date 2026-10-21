import { beforeEach, describe, expect, it } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { FakeClock } from "../../test/kit/clock.js";
import { Outlasted, Pacer } from "./pacer.js";
import { type DeliveryEvent, ReplyDelivery } from "./reply.js";
import {
  type DeliveryCapabilities,
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
    readonly capabilities: DeliveryCapabilities = {
      maxPartLength: 20,
      edit: true,
      budget: OPEN_BUDGET,
    },
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
    return { messageId: id, chatId: this.conversation };
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

    it("edits a settled part again when its block's complete text arrives a second time, different", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(text("First version of it", "a"));
      await advance(0);
      await advance(0);
      expect(platform.shown).toEqual(["First version of it"]);

      delivery.accept(text("Final version of it", "a"));
      await delivery.finish();
      expect(platform.shown).toEqual(["Final version of it"]);
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
      // One code unit per delta, so each emoji arrives as two halves.
      for (const unit of source.split("")) {
        delivery.accept(delta(unit));
        await advance(0);
      }
      delivery.accept(text(source));
      await delivery.finish();

      expect(platform.shown.join("")).toBe(source);
      for (const written of platform.messages.flatMap((m) => m.history)) {
        expect(written.length).toBeLessThanOrEqual(20);
        expect(written).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
    });

    it("never writes the first half of an emoji whose second half has not arrived", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      for (const content of ["\ud83d", "\ude00 Hello ", "\ud83d", "\ude00 ok"]) {
        delivery.accept(delta(content));
        await advance(0);
      }
      delivery.accept(text("😀 Hello 😀 ok"));
      await delivery.finish();

      expect(platform.messages.map((m) => m.history)).toEqual([["😀 Hello ", "😀 Hello 😀 ok"]]);
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

  describe("per-message edit cap", () => {
    const capped = (maxEditsPerMessage: number, maxPartLength = 100) => {
      platform = new MemoryPlatform({
        maxPartLength,
        maxEditsPerMessage,
        edit: true,
        budget: OPEN_BUDGET,
      });
      return reply();
    };

    it("settles at the last edit and keeps editing subsequent messages", async () => {
      const delivery = capped(2);
      await stream(delivery, "one two three four five six seven eight nine ", 1000);
      const finished = delivery.finish();
      await advance(1000);
      const outcome = await finished;

      expect(platform.messages.map((message) => message.history)).toEqual([
        ["one ", "one two ", "one two three "],
        ["four ", "four five ", "four five six "],
        ["seven ", "seven eight ", "seven eight nine "],
      ]);
      expect(outcome.status).toBe("delivered");
      expect(outcome.parts.every((part) => part.state === "settled")).toBe(true);
    });

    it("holds the last edit until a forward break without retracting shown text", async () => {
      const delivery = capped(1);
      delivery.accept(delta("one tw"));
      await advance(1000);
      delivery.accept(delta("o"));
      await advance(1000);
      expect(platform.messages[0]!.history).toEqual(["one tw"]);
      delivery.accept(delta(" three"));
      await advance(1000);
      expect(platform.messages.map((message) => message.history)).toEqual([
        ["one tw", "one two "],
        ["three"],
      ]);
      await delivery.finish();
      expect(platform.shown.join("")).toBe("one two three");
    });

    it("releases the last edit when the block completes without a forward break", async () => {
      const delivery = capped(1, 10);
      delivery.accept(delta("abc"));
      await advance(1000);
      delivery.accept(delta("def"));
      await advance(1000);
      expect(platform.messages[0]!.history).toEqual(["abc"]);
      const finished = delivery.finish();
      await advance(1000);
      expect((await finished).status).toBe("delivered");
      expect(platform.messages[0]!.history).toEqual(["abc", "abcdef"]);
    });

    it("releases the last edit when the message fills without a forward break", async () => {
      const delivery = capped(1, 10);
      delivery.accept(delta("abc"));
      await advance(1000);
      delivery.accept(delta("defghij"));
      await advance(1000);
      expect(platform.messages[0]!.history).toEqual(["abc"]);
      delivery.accept(delta("k"));
      await advance(1000);
      expect(platform.messages.map((message) => message.history)).toEqual([
        ["abc", "abcdefghij"],
        ["k"],
      ]);
      await delivery.finish();
    });

    it("never edits when the cap is zero", async () => {
      const delivery = capped(0);
      await stream(delivery, "one two three ", 1000);
      const outcome = await delivery.finish();
      expect(events.filter((event) => event.write === "edit")).toEqual([]);
      expect(platform.shown.join("")).toBe("one two three ");
      expect(outcome.status).toBe("delivered");
    });

    it.each([
      "rate-limited",
      "unavailable",
    ] as const)("does not charge a definite %s refusal", async (kind) => {
      const delivery = capped(1);
      delivery.accept(delta("one "));
      await advance(1000);
      platform.failures.push({ write: "edit", failure: new DeliveryFailure(kind, "try later") });
      delivery.accept(delta("two "));
      await advance(2000);
      delivery.accept(delta("three "));
      await advance(1000);
      const outcome = await delivery.finish();
      expect(events.filter((event) => event.write === "edit").map((event) => event.result)).toEqual(
        [kind, "accepted"],
      );
      expect(platform.shown).toEqual(["one two ", "three "]);
      expect(outcome.status).toBe("delivered");
    });

    it("charges an unknown edit and fails unknown when the cap leaves no reconciliation", async () => {
      const delivery = capped(1);
      delivery.accept(delta("one "));
      await advance(1000);
      platform.lostEditAnswers = 1;
      delivery.accept(delta("two three"));
      await advance(1000);
      const outcome = await delivery.finish();
      expect(outcome).toMatchObject({ status: "unknown", failure: { kind: "unknown" } });
      expect(events.filter((event) => event.write === "edit")).toHaveLength(1);
      expect(platform.shown).toEqual(["one two "]);
    });

    it("uses the remaining allowance to reconcile an unknown edit", async () => {
      const delivery = capped(2);
      delivery.accept(delta("one "));
      await advance(1000);
      platform.lostEditAnswers = 1;
      delivery.accept(delta("two "));
      await advance(2000);
      delivery.accept(delta("three "));
      await advance(1000);
      const outcome = await delivery.finish();
      expect(events.filter((event) => event.write === "edit").map((event) => event.result)).toEqual(
        ["unknown", "accepted"],
      );
      expect(platform.shown).toEqual(["one two ", "three "]);
      expect(outcome.status).toBe("delivered");
    });

    it("marks a rewritten capped part diverged without another edit", async () => {
      const delivery = capped(1);
      delivery.accept(delta("one ", "a"));
      await advance(1000);
      delivery.accept(delta("two ", "a"));
      await advance(1000);
      delivery.accept(text("ONE two three", "a"));
      const outcome = await delivery.finish();
      expect(platform.shown).toEqual(["one two ", "three"]);
      expect(events.filter((event) => event.write === "edit")).toHaveLength(1);
      expect(outcome).toMatchObject({ status: "delivered", diverged: true });
      expect(outcome.parts[0]).toMatchObject({ state: "settled", diverged: true });
    });

    it("retains reply-wide blocks fallback for unsupported edits", async () => {
      const delivery = capped(2);
      delivery.accept(delta("one "));
      await advance(1000);
      platform.failures.push({
        write: "edit",
        failure: new DeliveryFailure("unsupported", "cannot edit"),
      });
      delivery.accept(delta("two "));
      await advance(1000);
      delivery.accept(delta("three "));
      const finished = delivery.finish();
      await advance(2000);
      expect((await finished).status).toBe("delivered");
      expect(platform.shown).toEqual(["one ", "two three "]);
      expect(events.filter((event) => event.write === "edit").map((event) => event.result)).toEqual(
        ["unsupported"],
      );
    });
  });

  describe("codec context", () => {
    /** Reopens a code span that the source before the message left open.
     *  It requires context, so a render without it fails the reply. */
    const spans: DeliveryTransport["codec"] = {
      render: (source, _settled, context) => {
        if (!context) throw new Error("render without context");
        return (context.before.split("`").length - 1) % 2 ? `\`${source}` : source;
      },
      measure: (rendered) => rendered.length,
    };
    const withSpans = (capabilities: Partial<DeliveryCapabilities> = {}) => {
      platform = new MemoryPlatform({
        maxPartLength: 10,
        edit: true,
        budget: OPEN_BUDGET,
        ...capabilities,
      });
      Object.assign(platform, { codec: spans });
      return reply({ editIntervalMs: 0 });
    };

    it("fits a part that reopens a span in the limit", async () => {
      const delivery = withSpans();
      delivery.accept(text("ab `cdef ghijklmnop"));
      const outcome = await delivery.finish();
      expect(outcome.status).toBe("delivered");
      expect(platform.shown).toEqual(["ab `cdef ", "`ghijklmno", "`p"]);
    });

    it("edits a settled part whose source is unchanged when the text before it changes", async () => {
      const delivery = withSpans();
      delivery.accept(text("abcd efgh ijkl", "a"));
      await advance(0);
      await advance(0);
      expect(platform.shown).toEqual(["abcd efgh ", "ijkl"]);
      delivery.accept(text("abc` efgh ijkl", "a"));
      const outcome = await delivery.finish();
      expect(platform.shown).toEqual(["abc` efgh ", "`ijkl"]);
      expect(outcome.status).toBe("delivered");
    });

    it("gives the part after a capped one its context", async () => {
      const delivery = withSpans({ maxPartLength: 100, maxEditsPerMessage: 1 });
      delivery.accept(delta("`one "));
      await advance(0);
      delivery.accept(delta("two three"));
      await advance(0);
      await delivery.finish();
      expect(platform.shown).toEqual(["`one two ", "`three"]);
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

    it("sends the blocks after one the last turn left streaming before the reply finishes", async () => {
      const delivery = reply({ mode: "blocks" });
      delivery.accept(delta("Cut off"));
      delivery.accept({ type: "turn_start", turnId: "t2", sessionId: "s", userPrompt: "" });
      delivery.accept(text("Next."));
      await advance(0);
      await advance(0);

      expect(platform.shown).toEqual(["Cut off", "Next."]);
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
        receipt: { messageId: "m1", chatId: "c1" },
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
    // The platform's limit is 20. A bound of 20 fails while the first message fills, and one
    // just above it fails most replies of more than one message, so twice the limit is the least.
    expect(() => reply({ mode: "edit", maxPendingChars: 20 })).toThrow(/maxPendingChars/);
    expect(() => reply({ mode: "edit", maxPendingChars: 39 })).toThrow(/maxPendingChars/);
    expect(() => reply({ mode: "edit", maxPendingChars: 40 })).not.toThrow();
    expect(() => reply({ mode: "blocks", maxPendingChars: 5 })).toThrow(/maxPendingChars/);
    // A final reply waits by design and has no bound.
    expect(() => reply({ mode: "final", maxPendingChars: 5 })).not.toThrow();
  });

  it("fails rather than holding more unsent text than its bound", async () => {
    const delivery = reply({ mode: "edit", maxPendingChars: 40 });
    delivery.accept(delta("more than forty characters, which is more than the bound allows"));
    const outcome = await delivery.finish();
    expect(outcome).toMatchObject({ status: "failed", failure: { kind: "overflow" } });
    expect(platform.messages).toHaveLength(0);
  });

  it("delivers text that arrived complete and is longer than the bound, split into messages", async () => {
    // A provider that does not stream sends its answer whole, and it can be split and sent.
    const delivery = reply({ mode: "edit", editIntervalMs: 0, maxPendingChars: 40 });
    delivery.accept(text("x".repeat(100), "a"));
    delivery.accept(result("y".repeat(100)));
    const outcome = await delivery.finish();

    expect(outcome.status).toBe("delivered");
    expect(platform.shown.join("")).toBe(`${"x".repeat(100)}${"y".repeat(100)}`);
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

  describe("a write whose turn comes after the reply changed", () => {
    // Another write of the account holds the queue, so the reply's next write waits behind it.
    const held = (policy: Partial<DeliveryPolicy>, transport: DeliveryTransport = platform) => {
      const pacer = new Pacer(OPEN_BUDGET, clock);
      const delivery = new ReplyDelivery({
        transport,
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
        observe: (event) => events.push(event),
      });
      const hold = () => {
        let release = () => {};
        void pacer.run("c1", () => new Promise<void>((resolve) => (release = resolve)));
        return () => release();
      };
      return { delivery, hold };
    };

    it("edits a message no sooner than editIntervalMs after its last write, though another write's turn came", async () => {
      const { delivery, hold } = held({ editIntervalMs: 1000 });
      delivery.accept(text("Hello", "a"));
      await advance(0);
      const release = hold();
      // The second block's create waits behind the held write.
      delivery.accept(delta("World", "b"));
      await settle();
      // Meanwhile the first block's message, written just now, is revised.
      delivery.accept(text("Hullo", "a"));
      release();
      await advance(0);
      expect(platform.messages.map((m) => m.history)).toEqual([["Hello"]]);
      await advance(1000);
      delivery.accept(text("World", "b"));
      await delivery.finish();

      expect(platform.messages.map((m) => m.history)).toEqual([["Hello", "Hullo"], ["World"]]);
      const [create, edit] = events.filter((event) => event.block === 0);
      expect(edit!.at - create!.at).toBeGreaterThanOrEqual(1000);
    });

    it("sends a part that has waited out blockWaitMs at its turn, though another write went first", async () => {
      const { delivery, hold } = held({ mode: "blocks", blockWaitMs: 2000 });
      delivery.accept(text("First.", "a"));
      await advance(0);
      delivery.accept(delta("Second idea. More", "b"));
      await advance(1000);
      const release = hold();
      // The second block's part has waited 2000 ms, and its create waits behind the held write.
      await advance(1000);
      // Meanwhile the first block's complete text arrives again, longer, and its new text goes first.
      delivery.accept(text("First. Again", "a"));
      release();
      await advance(0);

      expect(platform.shown).toEqual(["First.", " Again", "Second idea."]);
      delivery.accept(text("Second idea. More", "b"));
      await delivery.finish();
      expect(platform.shown).toEqual(["First.", " Again", "Second idea.", " More"]);
    });

    it("reports what it found at the turn when the write it chose is refused", async () => {
      const four = new MemoryPlatform({ maxPartLength: 4, edit: true, budget: OPEN_BUDGET });
      const { delivery, hold } = held({}, four);
      delivery.accept(text("AAAA", "a"));
      await advance(0);
      delivery.accept(delta("BB", "b"));
      await advance(0);
      const release = hold();
      // The preview's edit waits behind the held write.
      delivery.accept(delta("BB", "b"));
      await settle();
      // Meanwhile the first block gains text that cannot go in front of the preview.
      delivery.accept(text("AAAAT", "a"));
      four.failures.push({ write: "edit", failure: new DeliveryFailure("rejected", "refused") });
      release();
      const outcome = await delivery.finish();

      expect(four.messages.map((m) => m.history)).toEqual([["AAAA"], ["BB"]]);
      expect(outcome.status).toBe("partial");
      expect(outcome.diverged).toBe(true);
      expect(outcome.parts.map((part) => [part.text, part.diverged])).toEqual([
        ["AAAA", undefined],
        ["BB", true],
      ]);
    });
  });

  describe("a write that waits in a paced queue", () => {
    const paused = (policy: Partial<DeliveryPolicy> = {}) => {
      const pacer = new Pacer(OPEN_BUDGET, clock);
      pacer.pause(1000, "rate-limited");
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
      const { delivery } = paused({ maxPendingChars: 40 });
      delivery.accept(delta("small", "a"));
      delivery.accept(delta(" and more than the bound of forty lets wait", "a"));
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

    it("keeps the part's end inside the block's text when the final text is shorter than the lost edit's", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      platform.lostEditAnswers = 1;
      await reviseBackWhileAnEditIsInFlight(delivery);
      const outcome = await delivery.finish();

      expect(outcome.status).toBe("delivered");
      // The lost edit carried "Hello world", but the block is "Hello".
      const probe = delivery as unknown as { blocks: Array<{ parts: Array<{ end: number }> }> };
      expect(probe.blocks[0]!.parts[0]!.end).toBeLessThanOrEqual("Hello".length);
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

    it("does not wait for its queued write once the reply has failed", async () => {
      // Another reply of the account got an hour's wait, so this reply's create waits in the queue.
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      pacer.pause(3_600_000, "rate-limited");
      const delivery = new ReplyDelivery({
        transport: platform,
        pacer,
        policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 40 },
        conversation: "c1",
        clock,
      });
      delivery.accept(delta("hello", "a"));
      await settle();
      // The text outgrows the bound, which fails the reply.
      delivery.accept(delta("x".repeat(60), "a"));
      const finished = delivery.finish();
      await settle();

      // The queued write is dropped at once, so finish() does not wait out its minute.
      const outcome = await Promise.race([finished, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "overflow" } });
    });

    it("fails the reply when the account's queue holds its write for longer than a minute", async () => {
      // Another reply of the account got an hour's wait, which pauses every write.
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      pacer.pause(3_600_000, "rate-limited");
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

    it("does not give up on a write that waits behind other conversations after its own limit", async () => {
      limited(50_000, 1);
      const { pacer, delivery } = onSharedPacer();
      // The first create is in flight when another conversation's write is queued behind it.
      let releaseCreate!: () => void;
      platform.hold = new Promise<void>((resolve) => (releaseCreate = resolve));
      delivery.accept(result("Hello"));
      await advance(0);
      let end = () => {};
      const ahead = pacer.run("c2", () => new Promise<void>((resolve) => (end = resolve)));
      const finished = delivery.finish();
      // The create meets a 50 s limit, so the account pauses and both writes wait.
      releaseCreate();
      platform.hold = undefined;
      await advance(0);
      // When the pause ends the other write goes first, and it takes its time.
      await advance(50_000);
      // The reply has now waited longer than a minute and a second in all.
      await advance(15_000);
      end();
      await ahead;
      await advance(0);

      expect((await finished).status).toBe("delivered");
      expect(platform.shown).toEqual(["Hello"]);
    });

    it("reports a limit that ended while the write was still queued as a rate limit", async () => {
      // An hour's wait elsewhere ended at 50 s, and the write is still behind another
      // conversation's when its own wait runs out, so no pause is in effect then.
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      pacer.pause(50_000, "rate-limited");
      let end = () => {};
      void pacer.run("c2", () => new Promise<void>((resolve) => (end = resolve)));
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
      // The pause was what held it back, though it is over by now.
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });
      end();
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

    it("reports a write held by its own conversation as unavailable, though another reply backed off from an outage meanwhile", async () => {
      const pacer = new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, clock);
      // An earlier call for this conversation is still running, past what its caller waited for.
      await pacer.run("c1", async () => new Outlasted(new Promise<void>(() => {})));
      const policy = {
        mode: "edit",
        editIntervalMs: 0,
        blockWaitMs: 0,
        maxPendingChars: 10_000,
      } as const;
      const held = new ReplyDelivery({
        transport: platform,
        pacer,
        policy,
        conversation: "c1",
        clock,
      });
      held.accept(result("Hello"));
      const finished = held.finish();
      await settle();
      // Another conversation's create cannot reach the platform, so the account backs off.
      platform.failures.push({
        write: "create",
        failure: new DeliveryFailure("unavailable", "getaddrinfo EAI_AGAIN"),
      });
      const other = new ReplyDelivery({
        transport: platform,
        pacer,
        policy,
        conversation: "c2",
        clock,
      });
      other.accept(result("Hi"));
      const otherFinished = other.finish();
      await advance(61_000);
      await settle();

      expect((await otherFinished).status).toBe("delivered");
      const outcome = await Promise.race([finished, Promise.resolve("hung" as const)]);
      expect(outcome).not.toBe("hung");
      // The backoff was no rate limit, and waiting one out would not help.
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
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
      pacer.pause(3_600_000, "rate-limited");
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

    it("counts a limit that names no wait as a second, so an answer of zero cannot loop without bound", async () => {
      // A platform that keeps answering "retry after 0" would otherwise be tried again at once, for ever.
      limited(0, 1000);
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(70_000);

      expect(await finished).toMatchObject({ status: "failed", failure: { kind: "rate-limited" } });
      // About a minute of seconds, and not a thousand tries.
      expect(platform.failures.length).toBeGreaterThan(900);
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

  describe("a write that certainly did not arrive", () => {
    const unreachable = () => new DeliveryFailure("unavailable", "getaddrinfo EAI_AGAIN");

    it("is tried again, so a brief outage in the middle of a reply does not cut it short", async () => {
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(delta("Hello there my friend, nice day", "a"));
      await advance(0);
      // The edit that settles the first message meets an outage twice and then goes through.
      platform.failures.push({ write: "edit", failure: unreachable() });
      platform.failures.push({ write: "edit", failure: unreachable() });
      delivery.accept(text("Hello there my friend, nice day and more", "a"));
      const finished = delivery.finish();
      await advance(10_000);

      const outcome = await finished;
      expect(outcome.status).toBe("delivered");
      expect(platform.shown.join("")).toBe("Hello there my friend, nice day and more");
    });

    it("is tried again a few times and then fails, so an outage that lasts cannot hold the reply", async () => {
      for (let i = 0; i < 10; i++)
        platform.failures.push({ write: "create", failure: unreachable() });
      const delivery = reply({ editIntervalMs: 0 });
      delivery.accept(result("Hello"));
      const finished = delivery.finish();
      await advance(30_000);

      const outcome = await finished;
      expect(outcome).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
      // The first try and three more, and no write ever showed.
      expect(platform.failures).toHaveLength(6);
      expect(platform.messages).toHaveLength(0);
    });
  });

  it("fails, and does not report unknown, when the platform could not be reached", async () => {
    // The outage lasts through the first try and every try again. A write that certainly did
    // not arrive may be sent again, so a caller can send the reply whole.
    for (let i = 0; i < 4; i++)
      platform.failures.push({
        write: "create",
        failure: new DeliveryFailure("unavailable", "getaddrinfo ENOTFOUND"),
      });
    const delivery = reply({ editIntervalMs: 0 });
    delivery.accept(result("Hello"));
    const finished = delivery.finish();
    await advance(10_000);
    const outcome = await finished;

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

    it("sends a complete block that a final text made visible, however long it is against the bound", async () => {
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
      // It was produced whole, so the bound on a backlog does not apply to it.
      delivery.accept(text("a".repeat(60), "a"));
      release();
      const outcome = await delivery.finish();

      expect(outcome.status).toBe("delivered");
      expect(platform.shown.join("")).toBe("a".repeat(60));
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

  describe("a block that grows after a later block's message", () => {
    // Each message holds four characters, so the first block's new text needs a message of its own.
    const narrow = () => new MemoryPlatform({ maxPartLength: 4, edit: true, budget: OPEN_BUDGET });

    for (const mode of ["edit", "blocks"] as const) {
      it(`keeps the messages in order and reports the message after its new text as differing, in ${mode} mode`, async () => {
        const four = narrow();
        const delivery = reply({ mode, editIntervalMs: 0, blockWaitMs: 0 }, four);
        delivery.accept(text("AAAA", "a"));
        await advance(0);
        delivery.accept(text("BBBB", "b"));
        await advance(0);
        // A second complete text for the first block, one character longer.
        delivery.accept(text("AAAAT", "a"));
        const outcome = await delivery.finish();

        expect(four.messages.map((m) => m.history)).toEqual([["AAAA"], ["BBBB"]]);
        expect(outcome.status).toBe("delivered");
        expect(outcome.diverged).toBe(true);
        expect(outcome.parts.map((part) => [part.text, part.diverged])).toEqual([
          ["AAAA", undefined],
          ["BBBB", true],
        ]);
      });
    }
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
    // Each block carries 25 spaces that are never sent. With them counted, 60 characters would wait.
    // The blocks are still streaming, since a block the agent completed is not counted at all.
    const delivery = reply({ editIntervalMs: 0, maxPendingChars: 40 });
    delivery.accept(delta(`${" ".repeat(25)}hello`, "a"));
    await advance(100);
    delivery.accept(delta(`${" ".repeat(25)}world`, "b"));
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

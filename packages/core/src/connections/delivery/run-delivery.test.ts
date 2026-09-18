import { describe, expect, it } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import type { DeliveryProfile } from "./profile.js";
import { RunDelivery } from "./run-delivery.js";
import { DeliveryScheduler } from "./scheduler.js";
import {
  DeliveryFailure,
  plainTextCodec,
  type DeliveryAttempt,
  type TextTransport,
} from "./transport.js";

const profile: DeliveryProfile = {
  mode: "edit",
  unsupportedMode: "blocks",
  budgetKey: "synthetic",
  operationSpacingMs: 0,
  createSpacingMs: 0,
  updateSpacingMs: 0,
  conversationSpacingMs: 0,
  burstCapacity: 1,
  maxPartSize: 12,
  coalesceMs: 0,
  maxPendingAgeMs: 1000,
  maxPendingBytes: 10000,
  maxQueuedOperations: 100,
  formatting: "plain",
  formattingFallback: true,
};

function setup(overrides: Partial<TextTransport> = {}) {
  const visible = new Map<string, string>();
  const updates = new Map<string, number>();
  const evidence: DeliveryAttempt[] = [];
  const transport: TextTransport = {
    profile,
    codec: plainTextCodec,
    assertAuthorized() {},
    async create(target, text) {
      const messageId = String(visible.size);
      visible.set(messageId, text);
      return { messageId, conversationId: target.conversationId };
    },
    async update(receipt, text) {
      visible.set(receipt.messageId!, text);
      updates.set(receipt.messageId!, (updates.get(receipt.messageId!) ?? 0) + 1);
    },
    ...overrides,
  };
  const run = new RunDelivery(
    "run",
    { conversationId: "conversation" as ConversationId },
    transport,
    new DeliveryScheduler(),
    {
      async record(attempt) {
        evidence.push(attempt);
      },
    },
    () => {},
  );
  return { run, visible, updates, evidence };
}

async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("RunDelivery", () => {
  it.each([
    false,
    true,
  ])("enforces UTF-8 memory bounds and retains accepted receipts (in-flight=%s)", async (inFlight) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const { run, evidence } = setup({
      profile: { ...profile, maxPendingBytes: 6 },
      async create(target, text) {
        sent.push(text);
        if (inFlight) await gate;
        return { messageId: "accepted", conversationId: target.conversationId };
      },
    });
    try {
      run.append("中文");
      await tick();
      run.append("a");
      run.append("ignored");
      release();
      await expect(run.finish("ignored")).rejects.toMatchObject({
        kind: "failed",
        message: "Run delivery memory bound exceeded",
        receipts: [expect.objectContaining({ messageId: "accepted" })],
      });
      expect(sent).toEqual(["中文"]);
      expect(run.signal.aborted).toBe(true);
      expect(evidence.some((attempt) => attempt.outcome === "accepted")).toBe(true);
    } finally {
      release();
      await run.stop();
    }
  });

  it("rejects an oversized final result before any transport call", async () => {
    const { run, visible } = setup({ profile: { ...profile, mode: "final", maxPendingBytes: 6 } });
    await expect(run.finish("中文a")).rejects.toMatchObject({ kind: "failed", receipts: [] });
    expect(visible.size).toBe(0);
  });

  it.each([
    "blocks",
    "final",
  ] as const)("switches to %s when editing becomes unsupported", async (unsupportedMode) => {
    let edits = 0;
    const { run, visible } = setup({
      profile: { ...profile, unsupportedMode },
      async update() {
        edits++;
        throw new DeliveryFailure("unsupported", "editing disabled");
      },
    });
    try {
      run.append("old");
      await tick();
      run.complete("changed", "final");
      await tick();
      expect(edits).toBe(1);
      expect([...visible.values()].join("")).toBe(
        unsupportedMode === "final" ? "old" : "oldCorrection:\nchanged",
      );
      const final = unsupportedMode === "final" ? "latest" : "changed";
      await run.finish(final);
      expect([...visible.values()].join("")).toBe(`oldCorrection:\n${final}`);
      expect(edits).toBe(1);
    } finally {
      await run.stop();
    }
  });

  it("falls back when a previously settled overflow part loses editing support", async () => {
    let edits = 0;
    const { run, visible, evidence } = setup({
      profile: { ...profile, maxPartSize: 4 },
      async update() {
        edits++;
        throw new DeliveryFailure("unsupported", "editing disabled");
      },
    });
    try {
      run.append("abcdefgh");
      await tick();
      run.complete("ABCDEFGH", "final");
      await run.finish("ABCDEFGH");
      expect([...visible.values()].join("")).toBe("abcdefghCorrection:\nABCDEFGH");
      expect(edits).toBe(1);
      expect(
        evidence.filter((attempt) => attempt.partIx === 0 && attempt.blockIx === 0).at(-1),
      ).toMatchObject({ outcome: "accepted", operation: "settle" });
    } finally {
      await run.stop();
    }
  });

  it.each([
    "short",
    "ab😀efghij",
  ])("uses a correction when final text changes physical boundaries: %s", async (final) => {
    const { run, visible, updates } = setup({ profile: { ...profile, maxPartSize: 3 } });
    try {
      run.append("abcdefghij");
      await tick();
      const prefix = [...visible.values()];
      run.complete(final, "final");
      await run.finish(final);
      expect([...visible.values()].slice(0, prefix.length)).toEqual(prefix);
      expect([...visible.values()].slice(prefix.length).join("")).toBe(`Correction:\n${final}`);
      expect(updates.size).toBe(0);
      for (const part of visible.values()) {
        expect(part.length).toBeLessThanOrEqual(3);
        expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part)).toBe(false);
      }
    } finally {
      await run.stop();
    }
  });

  it("keeps append-only corrections distinct from later provider blocks and does not repeat a final correction", async () => {
    const { run, visible } = setup({ profile: { ...profile, mode: "blocks" }, update: undefined });
    run.complete("old", "commentary", "commentary");
    await tick();
    run.complete("new", "commentary", "commentary");
    await tick();
    run.complete("answer", "final", "final");
    await tick();
    run.complete("revised", "final", "final");
    await tick();
    await run.finish("revised");
    expect([...visible.values()].join("|")).toBe(
      "old|Correction:\n|new|answer|Correction:\n|revised",
    );
  });
  it("appends an unchanged suffix after an append-only overflow part", async () => {
    const { run, visible } = setup({ profile: { ...profile, mode: "blocks" }, update: undefined });
    run.append("abcdefghijklm");
    await tick();
    expect([...visible.values()]).toEqual(["abcdefghijkl"]);
    run.complete("abcdefghijklmnop", "final");
    await run.finish("abcdefghijklmnop");
    expect([...visible.values()]).toEqual(["abcdefghijkl", "mnop"]);
  });
  it("reconciles an unknown edit before another final edit", async () => {
    const operations: string[] = [];
    let edits = 0;
    const { run } = setup({
      async update(_receipt, text) {
        operations.push(`update:${text}`);
        if (++edits === 1) throw new DeliveryFailure("unknown", "timed out");
      },
      async reconcile() {
        operations.push("reconcile");
        return { text: "a", quiescent: true };
      },
    });
    run.append("a");
    await tick();
    await run.finish("final");
    expect(operations).toEqual(["update:final", "reconcile", "update:final"]);
  });

  it("retains uncertainty when a timed-out edit cannot be ordered", async () => {
    let edits = 0;
    const { run } = setup({
      async update() {
        edits++;
        throw new DeliveryFailure("unknown", "timed out");
      },
      async reconcile() {
        return { text: "a", quiescent: false };
      },
    });
    run.append("a");
    await tick();
    await expect(run.finish("final")).rejects.toMatchObject({ kind: "unknown" });
    expect(edits).toBe(1);
  });

  it("never repeats an accepted create when recording its receipt fails", async () => {
    let creates = 0;
    const failures: unknown[] = [];
    const run = new RunDelivery(
      "run",
      { conversationId: "dm" as ConversationId },
      {
        profile,
        codec: plainTextCodec,
        assertAuthorized() {},
        async create(target) {
          creates++;
          return { messageId: "accepted", conversationId: target.conversationId };
        },
      },
      new DeliveryScheduler(),
      {
        async record(attempt) {
          if (attempt.outcome === "accepted") throw new Error("disk write failed");
        },
      },
      (error) => failures.push(error),
    );
    expect(await run.finish("final")).toEqual([{ messageId: "accepted", conversationId: "dm" }]);
    expect(creates).toBe(1);
    expect(failures).toHaveLength(2);
  });

  it("publishes an explicit correction when append-only output has changed", async () => {
    const { run, visible } = setup({ profile: { ...profile, mode: "blocks" }, update: undefined });
    run.complete("old", "final");
    await tick();
    await run.finish("revised");
    expect([...visible.values()].join("")).toBe("oldCorrection:\nrevised");
  });
  it.each(["blocks", "final"] as const)("uses the same owner in %s mode", async (mode) => {
    const { run, visible, updates } = setup({ profile: { ...profile, mode } });
    run.append("partial");
    await tick();
    expect(visible.size).toBe(0);
    run.complete("complete", "final");
    await run.finish("complete");
    expect([...visible.values()]).toEqual(["complete"]);
    expect(updates.size).toBe(0);
  });

  it("retains Chinese, emoji, links and fenced code across physical boundaries", async () => {
    const { run, visible } = setup();
    const source = "中文😀😀\n[链接](https://example.com)\n```ts\nconst x = '😀';\n```";
    await run.finish(source);
    expect([...visible.values()].join("")).toBe(source);
    for (const part of visible.values()) {
      expect(part.length).toBeLessThanOrEqual(profile.maxPartSize);
      expect(
        [...part].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)),
      ).toBe(false);
    }
  });

  it("retains the latest snapshot while rate limited", async () => {
    let creates = 0;
    const sent: string[] = [];
    const { run } = setup({
      async create(target, text) {
        if (++creates === 1) throw new DeliveryFailure("rate-limit", "wait", [], 20);
        sent.push(text);
        return { messageId: "one", conversationId: target.conversationId };
      },
    });
    run.append("first");
    await tick();
    run.append(" obsolete");
    run.complete("final", "final");
    await run.finish("final");
    expect(sent).toEqual(["final"]);
    expect(creates).toBe(2);
  });

  it("does not fall back to a new create after authorization rejection", async () => {
    let creates = 0;
    const { run } = setup({
      async create(target) {
        creates++;
        return { messageId: "one", conversationId: target.conversationId };
      },
      async update() {
        throw new DeliveryFailure("authorization", "revoked");
      },
    });
    run.append("a");
    await tick();
    await expect(run.finish("answer")).rejects.toMatchObject({ kind: "authorization" });
    expect(creates).toBe(1);
  });
  it("progressively creates, updates and settles every one of three physical parts", async () => {
    const { run, visible, updates, evidence } = setup();
    const source = "abcdefghijklmnopqrstuvwxyz1234567890";
    for (const character of source) {
      run.append(character);
      await tick();
    }
    run.complete(source, "final");
    await run.finish(source);
    expect([...visible.values()].join("")).toBe(source);
    expect(visible.size).toBe(3);
    expect([...updates.values()]).toHaveLength(3);
    for (const count of updates.values()) expect(count).toBeGreaterThan(1);
    expect(evidence.filter((attempt) => attempt.operation === "settle")).toHaveLength(3);
  });

  it("streams subsequent commentary and final blocks without replacing earlier commentary", async () => {
    const { run, visible, updates } = setup();
    for (const [index, source] of ["first", "second", "answer"].entries()) {
      for (const character of source) {
        run.append(character);
        await tick();
      }
      run.complete(source, index === 2 ? "final" : "commentary");
      await tick();
    }
    await run.finish("answer");
    expect([...visible.values()]).toEqual(["first", "second", "answer"]);
    for (const count of updates.values()) expect(count).toBeGreaterThan(1);
  });

  it("keeps a single create in flight and replaces its pending snapshot with the final", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let creates = 0;
    const sent: string[] = [];
    const { run } = setup({
      async create(target, text) {
        creates++;
        sent.push(text);
        await gate;
        return { messageId: "one", conversationId: target.conversationId };
      },
      async update(_receipt, text) {
        sent.push(text);
      },
    });
    run.append("a");
    await tick();
    run.append("bc");
    run.complete("final", "final");
    const finished = run.finish("final");
    release();
    await finished;
    expect(creates).toBe(1);
    expect(sent).toEqual(["a", "final"]);
  });

  it("uses owned edits for authoritative final corrections", async () => {
    const { run, visible } = setup();
    run.complete("old", "final");
    await tick();
    await run.finish("new");
    expect([...visible.values()]).toEqual(["new"]);
  });

  it("does not replay completed content as artificial frames", async () => {
    const { run, visible, updates } = setup();
    await run.finish("a complete answer longer than one part");
    expect([...visible.values()].join("")).toBe("a complete answer longer than one part");
    expect(updates.size).toBe(0);
  });

  it("preserves receipts and never retries an ambiguous later create", async () => {
    let count = 0;
    const { run } = setup({
      async create(target) {
        if (++count === 2) throw new DeliveryFailure("unknown", "timeout");
        return { messageId: "known", conversationId: target.conversationId };
      },
    });
    await expect(run.finish("abcdefghijklmnopqrstuvwxyz")).rejects.toMatchObject({
      kind: "unknown",
      receipts: [{ messageId: "known", conversationId: "conversation" }],
    });
    expect(count).toBe(2);
  });

  it("records a create that completes after Stop without sending pending text", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let updates = 0;
    const { run, evidence } = setup({
      async create(target) {
        await gate;
        return { messageId: "accepted", conversationId: target.conversationId };
      },
      async update() {
        updates++;
      },
    });
    run.append("first");
    await tick();
    run.append("later");
    const stopped = run.stop();
    release();
    await stopped;
    expect(updates).toBe(0);
    expect(run.receipts[0].messageId).toBe("accepted");
    expect(evidence.some((attempt) => attempt.outcome === "accepted")).toBe(true);
  });
});

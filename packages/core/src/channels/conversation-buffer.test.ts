import { describe, expect, it, rs } from "@rstest/core";
import { ConversationBuffers, type ConversationBufferLimits } from "./conversation-buffer.js";

/** A handler that holds each item until the test releases it. */
function heldHandler() {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const handle = (item: string) => {
    started.push(item);
    return new Promise<void>((resolve) => releases.push(resolve));
  };
  return { started, handle, release: () => releases.shift()?.() };
}

function buffers(
  handle: (item: string) => Promise<void>,
  limits: Partial<ConversationBufferLimits>,
) {
  const log = { warn: rs.fn(), error: rs.fn() };
  const buffer = new ConversationBuffers<string>(handle, {
    log,
    describe: (item) => ({ item }),
    limits,
  });
  return { buffer, log };
}

describe("ConversationBuffers", () => {
  it("drops the oldest waiting event past capacity, and logs it", async () => {
    const held = heldHandler();
    const { buffer, log } = buffers(held.handle, { capacity: 2 });

    for (const item of ["a", "b", "c", "d"]) buffer.push("chat", item);

    // "a" is being handled; "b" was the oldest waiting when "d" arrived.
    expect(buffer.depth("chat")).toBe(2);
    expect(log.warn).toHaveBeenCalledWith("inbound event dropped: conversation buffer full", {
      conversation: "chat",
      capacity: 2,
      item: "b",
    });
    held.release();
    await rs.waitFor(() => expect(held.started).toEqual(["a", "c"]));
    held.release();
    await rs.waitFor(() => expect(held.started).toEqual(["a", "c", "d"]));
    held.release();
    await rs.waitFor(() => expect(buffer.size).toBe(0));
  });

  it("warns once when a conversation backs up, and again after it drains", async () => {
    const held = heldHandler();
    const { buffer, log } = buffers(held.handle, { depthWarning: 2 });
    const backingUp = () =>
      log.warn.mock.calls.filter(([message]) => message === "inbound conversation backing up");

    for (const item of ["a", "b", "c", "d"]) buffer.push("chat", item);
    expect(backingUp()).toEqual([
      ["inbound conversation backing up", { conversation: "chat", waiting: 2 }],
    ]);

    for (let i = 0; i < 4; i++) {
      held.release();
      await rs.waitFor(() => expect(held.started).toHaveLength(Math.min(i + 2, 4)));
    }
    await rs.waitFor(() => expect(buffer.size).toBe(0));
    for (const item of ["e", "f", "g"]) buffer.push("chat", item);
    expect(backingUp()).toHaveLength(2);
  });

  it("reports a handler still running past the threshold without stopping it", async () => {
    const held = heldHandler();
    const { buffer, log } = buffers(held.handle, { slowHandlerMs: 20 });

    buffer.push("chat", "slow");
    buffer.push("chat", "next");
    await rs.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith("inbound handler still running", {
        conversation: "chat",
        runningMs: 20,
        item: "slow",
      }),
    );
    expect(held.started).toEqual(["slow"]);
    held.release();
    await rs.waitFor(() => expect(held.started).toEqual(["slow", "next"]));
  });

  it("drops waiting events on close and lets the running handler finish", async () => {
    const held = heldHandler();
    const { buffer } = buffers(held.handle, {});

    buffer.push("chat", "running");
    buffer.push("chat", "waiting");
    buffer.close();
    buffer.push("chat", "late");
    held.release();

    await rs.waitFor(() => expect(buffer.size).toBe(0));
    expect(held.started).toEqual(["running"]);
  });
});

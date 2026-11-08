import { describe, expect, it } from "@rstest/core";
import { keepsFork, openFork, type ForkSource } from "./fork.js";

const position = { provider: "openai" as const, modelThreadId: "thread-1", checkpointId: "turn-2" };
const source: ForkSource = {
  providerId: "openai",
  modelThreadId: "thread-1",
  lastPosition: position,
  threadContext: { channel: "webchat", threadId: "source-chat" },
};

describe("openFork", () => {
  it("branches a one-shot isolated fork from the source's last turn", () => {
    expect(openFork(source, {}, "fork-1")).toEqual({
      mode: "isolated",
      sourceTurn: position,
      threadContext: source.threadContext,
    });
  });

  it("branches from the checkpoint the caller names", () => {
    const opening = openFork(
      source,
      {
        checkpoint: { providerId: "openai", providerThreadId: "thread-1", checkpointId: "turn-1" },
      },
      "fork-1",
    );
    expect(opening.sourceTurn).toEqual({
      provider: "openai",
      modelThreadId: "thread-1",
      checkpointId: "turn-1",
    });
  });

  it("keeps a continuable fork under the continuity key built from its session id", () => {
    expect(
      openFork(source, { mode: "exact", continuityKey: (id) => `fork:${id}` }, "fork-1"),
    ).toMatchObject({ mode: "exact", continuityKey: "fork:fork-1" });
  });

  it("carries the thread context the caller gives over the source's", () => {
    const threadContext = { channel: "telegram", threadId: "other" };
    expect(openFork(source, { threadContext }, "fork-1").threadContext).toBe(threadContext);
  });

  it("refuses a checkpoint from another provider", () => {
    expect(() =>
      openFork(
        source,
        { checkpoint: { providerId: "anthropic", providerThreadId: "t", checkpointId: "c" } },
        "fork-1",
      ),
    ).toThrow("Fork checkpoint provider anthropic does not match live provider openai");
  });

  it("refuses a checkpoint on another model thread", () => {
    expect(() =>
      openFork(
        source,
        { checkpoint: { providerId: "openai", providerThreadId: "thread-0", checkpointId: "c" } },
        "fork-1",
      ),
    ).toThrow("Fork checkpoint belongs to a different model thread");
  });

  it("refuses a source no turn has left a checkpoint on", () => {
    expect(() => openFork({ providerId: "openai" }, {}, "fork-1")).toThrow(
      "Cannot fork before a turn has left a checkpoint",
    );
  });
});

describe("keepsFork", () => {
  const continuable = openFork(source, { continuityKey: (id) => `fork:${id}` }, "fork-1");

  it("keeps a continuable fork that completed on a thread of its own", () => {
    expect(
      keepsFork(continuable, {
        completed: true,
        modelThreadId: "fork-thread",
        sourceModelThreadId: "thread-1",
      }),
    ).toBe(true);
  });

  it("keeps no one-shot fork, failed fork, or fork run inside the source thread", () => {
    const ran = { completed: true, modelThreadId: "fork-thread", sourceModelThreadId: "thread-1" };
    expect(keepsFork(openFork(source, {}, "fork-1"), ran)).toBe(false);
    expect(keepsFork(continuable, { ...ran, completed: false })).toBe(false);
    expect(keepsFork(continuable, { ...ran, modelThreadId: "thread-1" })).toBe(false);
  });
});

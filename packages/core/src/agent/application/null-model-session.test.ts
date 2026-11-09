import { describe, expect, it } from "@rstest/core";
import type { ModelSessionEvent } from "../domain/model-port.js";
import { NO_ROME_TOOLS } from "../domain/rome-tools.js";
import { createNullModelSession } from "./null-model-session.js";

describe("createNullModelSession", () => {
  it("code-backed null session parks until close and never resumes a provider", async () => {
    const session = createNullModelSession({
      config: { model: "code-backed", systemPrompt: "unused", builtinTools: [] },
      tools: NO_ROME_TOOLS,
      thread: { kind: "new" },
    });
    expect(session.providerId).toBe("mock");
    expect(session.modelThreadId).toBeUndefined();

    // The events stream parks (no provider query, nothing to resume/error) until
    // close() ends it — proven by racing the iterator against a timer.
    const iterator = session.events[Symbol.asyncIterator]();
    const raced = await Promise.race([
      iterator.next(),
      new Promise<"parked">((resolve) => setTimeout(() => resolve("parked"), 20)),
    ]);
    expect(raced).toBe("parked");

    await session.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("code-backed null session terminates gracefully if sendUserInput is ever reached", async () => {
    // A correctly-configured code-backed agent short-circuits via middleware, so
    // sendUserInput is never called. If it is (no middleware matched), the turn
    // must terminate rather than hang: a fallback text + error land on events.
    const session = createNullModelSession({
      config: { model: "code-backed", systemPrompt: "unused", builtinTools: [] },
      tools: NO_ROME_TOOLS,
      thread: { kind: "new" },
    });
    const drained: ModelSessionEvent[] = [];
    const collector = (async () => {
      for await (const msg of session.events) drained.push(msg);
    })();
    await session.sendUserInput({ text: "anything" });
    await session.close();
    await collector;
    expect(drained.map((m) => m.type)).toEqual(["text", "error"]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../types.js";
import {
  FilePiSessionStore,
  finalResult,
  forkEntriesForCheckpoint,
  type PiAssistantMessage,
  PiProvider,
  serializeToolOutput,
  translatePiSessionEvent,
  turnAccounting,
} from "./pi-provider.js";
import { PiRuntimeManager } from "./pi-runtime.js";

function assistantMessage(overrides: Partial<PiAssistantMessage> = {}): PiAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } },
    stopReason: "stop",
    ...overrides,
  };
}

function collect(event: AgentSessionEvent): {
  messages: AgentMessage[];
  assistants: PiAssistantMessage[];
} {
  const messages: AgentMessage[] = [];
  const assistants: PiAssistantMessage[] = [];
  translatePiSessionEvent(event, {
    pushMessage: (message) => messages.push(message),
    collectAssistant: (message) => assistants.push(message),
  });
  return { messages, assistants };
}

describe("PiProvider", () => {
  it("registers as Pi and delegates no built-in tools", () => {
    const provider = new PiProvider({
      runtime: new PiRuntimeManager(async () => ({ getAvailable: async () => [] })),
      store: { load: async () => [], save: async () => undefined },
    });
    expect(provider.id).toBe("pi");
    expect(provider.displayName).toBe("Pi Coding Agent");
    expect([...provider.builtinTools]).toEqual([]);
  });
});

describe("serializeToolOutput", () => {
  it("passes strings through and JSON-encodes objects", () => {
    expect(serializeToolOutput("plain")).toBe("plain");
    expect(serializeToolOutput({ a: 1 })).toBe('{"a":1}');
  });

  it("never returns undefined even when JSON.stringify would", () => {
    // Reachable when a tool throws and Pi reports no result.
    expect(serializeToolOutput(undefined)).toBe("undefined");
  });
});

describe("turnAccounting", () => {
  it("sums usage across every assistant message and attributes provider pi", () => {
    const accounting = turnAccounting(
      [
        assistantMessage(),
        assistantMessage({
          usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 3, cost: { total: 0.25 } },
          stopReason: "stop",
        }),
      ],
      "openai/gpt",
    );
    expect(accounting).toMatchObject({
      provider: "pi",
      model: "openai/gpt",
      usage: { inputTokens: 14, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 4 },
      costUsd: 0.75,
      numTurns: 2,
      stopReason: "stop",
    });
  });
});

describe("finalResult", () => {
  it("reports an error when no assistant message arrived", () => {
    expect(finalResult([], "m", undefined)).toMatchObject({ type: "error" });
  });

  it("maps aborted and error stop reasons to error results", () => {
    expect(
      finalResult([assistantMessage({ stopReason: "aborted" })], "m", undefined),
    ).toMatchObject({ type: "error", error: "Pi turn was cancelled" });
    expect(finalResult([assistantMessage({ stopReason: "error" })], "m", undefined)).toMatchObject({
      type: "error",
    });
  });

  it("returns the assistant text as a result when no output schema is set", () => {
    const result = finalResult(
      [assistantMessage({ content: [{ type: "text", text: "answer" }] })],
      "m",
      undefined,
    );
    expect(result).toMatchObject({ type: "result", content: "answer" });
    expect(result).not.toHaveProperty("structuredOutput");
  });

  it("parses structured output when a schema is set and JSON is valid", () => {
    const result = finalResult(
      [assistantMessage({ content: [{ type: "text", text: '{"ok":true}' }] })],
      "m",
      { type: "object" },
    );
    expect(result).toMatchObject({ type: "result", structuredOutput: { ok: true } });
  });

  it("falls back to plain content when structured output cannot be parsed", () => {
    const result = finalResult(
      [assistantMessage({ content: [{ type: "text", text: "not json" }] })],
      "m",
      { type: "object" },
    );
    expect(result).toMatchObject({ type: "result", content: "not json" });
    expect(result).not.toHaveProperty("structuredOutput");
  });
});

describe("translatePiSessionEvent", () => {
  it("streams text deltas", () => {
    const { messages } = collect({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    } as unknown as AgentSessionEvent);
    expect(messages).toEqual([{ type: "text_delta", content: "hi" }]);
  });

  it("emits a final text message and collects the assistant message", () => {
    const message = assistantMessage({ content: [{ type: "text", text: "done" }] });
    const { messages, assistants } = collect({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
    expect(assistants).toEqual([message]);
    expect(messages).toEqual([{ type: "text", content: "done", turnPhase: "final" }]);
  });

  it("marks text as commentary when the same message also calls a tool", () => {
    const message = assistantMessage({
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "toolCall", id: "t1", name: "act", arguments: {} },
      ],
    });
    const { messages } = collect({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
    expect(messages).toEqual([
      { type: "text", content: "thinking out loud", turnPhase: "commentary" },
    ]);
  });

  it("emits thinking content", () => {
    const message = assistantMessage({ content: [{ type: "thinking", thinking: "hmm" }] });
    const { messages } = collect({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
    expect(messages).toEqual([{ type: "thinking", content: "hmm" }]);
  });

  it("ignores a non-assistant message_end", () => {
    const { messages, assistants } = collect({
      type: "message_end",
      message: { role: "user", content: "hi" },
    } as unknown as AgentSessionEvent);
    expect(messages).toEqual([]);
    expect(assistants).toEqual([]);
  });

  it("maps tool execution start and end to tool_use/tool_result", () => {
    const start = collect({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "act",
      args: { x: 1 },
    } as unknown as AgentSessionEvent);
    expect(start.messages[0]).toMatchObject({
      type: "tool_use",
      id: "c1",
      tool: "act",
      input: { x: 1 },
    });

    const end = collect({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "act",
      result: { content: [{ type: "text", text: "ok" }] },
    } as unknown as AgentSessionEvent);
    expect(end.messages[0]).toMatchObject({ type: "tool_result", toolUseId: "c1", tool: "act" });
    expect(typeof (end.messages[0] as { output: string }).output).toBe("string");
  });
});

describe("forkEntriesForCheckpoint", () => {
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }] as never[];

  it("forks the full head when no checkpoint is given", () => {
    expect(forkEntriesForCheckpoint(entries, undefined)).toEqual(entries);
  });

  it("slices up to and including a known checkpoint", () => {
    expect(forkEntriesForCheckpoint(entries, "b")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("fails closed on an unknown checkpoint instead of forking the full head", () => {
    expect(() => forkEntriesForCheckpoint(entries, "missing")).toThrow(/unavailable/);
  });
});

describe("FilePiSessionStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-store-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips saved entries", async () => {
    const store = new FilePiSessionStore(root);
    const entries = [{ id: "x" }] as never[];
    await store.save("session-1", entries);
    await expect(store.load("session-1")).resolves.toEqual(entries);
  });

  it("returns an empty transcript for an unknown session", async () => {
    const store = new FilePiSessionStore(root);
    await expect(store.load("does-not-exist")).resolves.toEqual([]);
  });
});

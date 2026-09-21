import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createPiModelRuntime,
  discoverPiModels,
  inspectPiSessionIsolation,
  parseQualifiedPiModelId,
  PiEventBridge,
  qualifyPiModelId,
} from "./pi-sdk-prototype.js";

describe("Pi SDK provider prototype", () => {
  it("round-trips an unambiguous provider/model pair", () => {
    const qualified = qualifyPiModelId("custom/provider", "org/model/v2");
    expect(qualified).toBe("custom%2Fprovider/org%2Fmodel%2Fv2");
    expect(parseQualifiedPiModelId(qualified)).toEqual({
      upstreamProvider: "custom/provider",
      modelId: "org/model/v2",
    });
    expect(() => parseQualifiedPiModelId("openai/bad%2fcanonical")).toThrow(
      "Invalid qualified Pi model id",
    );
  });

  it("discovers authenticated custom models with colliding bare ids", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-provider-test-"));
    try {
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            alpha: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "test-placeholder",
              models: [{ id: "same/model" }],
            },
            beta: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "test-placeholder",
              models: [{ id: "same/model" }],
            },
          },
        }),
      );

      const runtime = await createPiModelRuntime({ agentDir });
      const discovery = await discoverPiModels(runtime);

      expect(discovery.configurationValid).toBe(true);
      expect(discovery.models.map((model) => model.qualifiedModelId)).toEqual([
        "alpha/same%2Fmodel",
        "beta/same%2Fmodel",
      ]);
      expect(JSON.stringify(discovery)).not.toContain("test-placeholder");
      expect(
        await inspectPiSessionIsolation({
          runtime,
          qualifiedModelId: discovery.models[0].qualifiedModelId,
        }),
      ).toMatchObject({ activeTools: ["rome_probe"], sessionFile: null });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("attributes Pi events to Pi while retaining the exact upstream model pair", () => {
    const bridge = new PiEventBridge("anthropic/claude-test");
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 12,
        output: 4,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 21,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    } satisfies Extract<AgentSessionEvent, { type: "message_end" }>["message"];

    expect(bridge.accept({ type: "message_end", message: assistantMessage })).toEqual([
      { type: "text", content: "done", turnPhase: "final" },
    ]);
    expect(
      bridge.accept({ type: "agent_end", messages: [assistantMessage], willRetry: false }),
    ).toEqual([
      {
        type: "result",
        content: "done",
        accounting: {
          provider: "pi",
          model: "anthropic/claude-test",
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
          },
          costUsd: 0,
          stopReason: "stop",
        },
      },
    ]);
  });

  it("emits one complete Rome thinking block rather than Pi thinking deltas", () => {
    const bridge = new PiEventBridge("anthropic/claude-test");
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "first second" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    } satisfies Extract<AgentSessionEvent, { type: "message_end" }>["message"];

    expect(
      bridge.accept({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "first ",
          partial: message,
        },
      }),
    ).toEqual([]);
    expect(
      bridge.accept({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "first second",
          partial: message,
        },
      }),
    ).toEqual([{ type: "thinking", content: "first second" }]);
  });
});

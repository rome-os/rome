import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  AgentMessage,
  AgentTurnFinishedEvent,
  ForkRunParams,
  RunParams,
  WebChatRecapMessage,
} from "@rome-os/app-runtime";
import {
  getRecapScore,
  meetsRecapThreshold,
  RECAP_PROMPT,
  RecapTurnFinishedHook,
  resolveWebchatSessionId,
  runForkedRecapTurn,
  shouldRecapTurn,
} from "./index.js";

const ttsCalls: string[] = [];
const ttsConfigs: Record<string, unknown>[] = [];

rs.mock("node-edge-tts", () => {
  return {
    EdgeTTS: class {
      constructor(config: Record<string, unknown>) {
        ttsConfigs.push(config);
      }

      async ttsPromise(_content: string, path: string): Promise<void> {
        ttsCalls.push(path);
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "mp3");
      }
    },
  };
});

function createEvent(overrides: Partial<AgentTurnFinishedEvent> = {}): AgentTurnFinishedEvent {
  return {
    type: "agent-turn-finished",
    version: 1,
    turn: {
      sessionId: "agent-session-1",
      turnId: "turn-1",
      agentName: "main",
      channelThreadKey: "webchat:sess-1:large-model:claude-haiku",
      threadContext: {
        channel: "webchat",
        threadId: "sess-1",
        threadPath: "/tmp/project/.threads/sess-1",
        channelUserId: "guardian",
        threadType: "private",
        projectName: "Demo",
        projectPath: "demo",
      },
    },
    status: "completed",
    timing: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    },
    output: { text: "Done with the task.", state: "final", terminalKind: "result" },
    metrics: { toolCallCount: 50, skillWritten: false },
    ...overrides,
  };
}

function createRunner(messages: AgentMessage[] = [{ type: "result", content: "Brief recap." }]) {
  const calls: RunParams[] = [];
  const forkCalls: ForkRunParams[] = [];
  return {
    calls,
    forkCalls,
    async *run(params: RunParams): AsyncIterable<AgentMessage> {
      calls.push(params);
      yield* messages;
    },
    async *runForked(params: ForkRunParams): AsyncIterable<AgentMessage> {
      forkCalls.push(params);
      yield* messages;
    },
  };
}

function createRepo(messages: WebChatRecapMessage[]) {
  const recaps: Record<string, unknown>[] = [];
  const sessionLookups: string[] = [];
  return {
    recaps,
    sessionLookups,
    async getSession(id: string) {
      sessionLookups.push(id);
      if (id !== "sess-1") return null;
      return {
        id: "sess-1",
        name: "Demo",
        projectName: "Demo",
        projectPath: "demo",
        agentName: null,
        createdAt: new Date(),
      };
    },
    async getMessages() {
      return messages;
    },
    async addTurnRecapMessage(input: Record<string, unknown>) {
      recaps.push(input);
      return {
        id: "recap-1",
        sessionId: input.sessionId as string,
        turnId: input.turnId as string,
        role: "assistant",
        content: JSON.stringify([{ type: "turn_recap", content: input.content }]),
        createdAt: new Date(),
      };
    },
  };
}

describe("recap agent-turn-finished hook", () => {
  let tempDir = "";

  beforeEach(() => {
    ttsCalls.length = 0;
    ttsConfigs.length = 0;
    tempDir = mkdtempSync(join(tmpdir(), "rome-recap-test-"));
    rs.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("filters to completed root WebChat turns", () => {
    expect(shouldRecapTurn(createEvent())).toBe(true);
    expect(
      shouldRecapTurn(createEvent({ turn: { ...createEvent().turn, agentName: "core:main" } })),
    ).toBe(true);
    expect(shouldRecapTurn(createEvent({ status: "error" }))).toBe(false);
    expect(
      shouldRecapTurn(createEvent({ output: { text: "", state: "none", terminalKind: "error" } })),
    ).toBe(false);
    expect(
      shouldRecapTurn(
        createEvent({
          turn: {
            ...createEvent().turn,
            parent: { sessionId: "s", turnId: "t", agentName: "main" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRecapTurn(
        createEvent({ turn: { ...createEvent().turn, channelThreadKey: "telegram:1" } }),
      ),
    ).toBe(false);
    expect(
      shouldRecapTurn(createEvent({ turn: { ...createEvent().turn, agentName: "recap" } })),
    ).toBe(false);
    expect(
      shouldRecapTurn(
        createEvent({
          turn: {
            ...createEvent().turn,
            threadContext: { ...createEvent().turn.threadContext!, channel: "recap" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRecapTurn(
        createEvent({
          turn: {
            ...createEvent().turn,
            threadContext: { ...createEvent().turn.threadContext!, threadType: "group" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("scores recaps from tool count and final response length", () => {
    const event = createEvent({
      metrics: { toolCallCount: 3, skillWritten: false },
      output: { text: "x".repeat(350), state: "final", terminalKind: "result" },
    });

    expect(getRecapScore(event)).toBe(410);
    expect(meetsRecapThreshold(event, "short")).toBe(true);
    expect(meetsRecapThreshold(event, "medium")).toBe(false);
    expect(shouldRecapTurn(event)).toBe(false);
  });

  it("resolves the WebChat session separately from the agent session", () => {
    expect(resolveWebchatSessionId(createEvent())).toBe("sess-1");
    expect(
      resolveWebchatSessionId(
        createEvent({
          turn: {
            ...createEvent().turn,
            threadContext: undefined,
            channelThreadKey: "webchat:sess-from-key:large-model:gpt-5-5",
          },
        }),
      ),
    ).toBe("sess-from-key");
  });

  it("forks the completed WebChat main-agent session and persists a text recap", async () => {
    const runner = createRunner();
    const repo = createRepo([
      {
        id: "u1",
        sessionId: "sess-1",
        turnId: "turn-1",
        role: "user",
        content: JSON.stringify([{ type: "text", content: "Ship the feature." }]),
        createdAt: new Date(),
      },
    ]);
    const hook = new RecapTurnFinishedHook({
      agentRunner: runner,
      webchatRecapRepo: repo,
      settingsRepo: {
        get: rs.fn(async (key: string) => {
          if (key === "recap.createAudio") return false;
          if (key === "recap.audioSpeed") return "normal";
          return "medium";
        }),
      },
      logger: { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() },
    });

    await hook.onAgentTurnFinished(createEvent());

    expect(repo.sessionLookups).toEqual(["sess-1"]);
    expect(runner.calls).toHaveLength(0);
    expect(runner.forkCalls).toHaveLength(1);
    expect(runner.forkCalls[0]).toMatchObject({
      agentName: "main",
      sourceSessionId: "agent-session-1",
      channelThreadKey: "webchat:sess-1:large-model:claude-haiku",
      prompt: RECAP_PROMPT,
      tier: "small",
      threadContext: {
        channel: "webchat",
        threadId: "sess-1",
      },
    });
    expect(repo.recaps).toEqual([
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        content: "Brief recap.",
      },
    ]);
  });

  it("skips turns below the selected recap threshold", async () => {
    const runner = createRunner();
    const repo = createRepo([]);
    const hook = new RecapTurnFinishedHook({
      agentRunner: runner,
      webchatRecapRepo: repo,
      settingsRepo: {
        get: rs.fn(async (key: string) => {
          if (key === "recap.createAudio") return false;
          if (key === "recap.audioSpeed") return "normal";
          return "medium";
        }),
      },
      logger: { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() },
    });

    await hook.onAgentTurnFinished(
      createEvent({
        metrics: { toolCallCount: 1, skillWritten: false },
        output: { text: "Short answer.", state: "final", terminalKind: "result" },
      }),
    );

    expect(runner.forkCalls).toHaveLength(0);
    expect(repo.sessionLookups).toHaveLength(0);
    expect(repo.recaps).toHaveLength(0);
  });

  it("creates audio when the settings toggle is enabled", async () => {
    const projectRoot = join(tempDir, "demo");
    await mkdir(join(projectRoot, ".threads", "sess-1"), { recursive: true });
    const repo = createRepo([
      {
        id: "u1",
        sessionId: "sess-1",
        turnId: "turn-1",
        role: "user",
        content: JSON.stringify([{ type: "text", content: "Make me a recap." }]),
        createdAt: new Date(),
      },
    ]);
    const hook = new RecapTurnFinishedHook({
      agentRunner: createRunner(),
      webchatRecapRepo: repo,
      settingsRepo: {
        get: rs.fn(async (key: string) => {
          if (key === "recap.createAudio") return true;
          if (key === "recap.audioSpeed") return "faster";
          return "medium";
        }),
      },
      logger: { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() },
    });

    await hook.onAgentTurnFinished(
      createEvent({
        turn: {
          ...createEvent().turn,
          threadContext: {
            ...createEvent().turn.threadContext!,
            threadPath: join(projectRoot, ".threads", "sess-1"),
          },
        },
      }),
    );

    expect(ttsCalls).toHaveLength(1);
    expect(ttsConfigs[0]).toEqual(
      expect.objectContaining({
        rate: "+15%",
      }),
    );
    expect(repo.recaps[0]).toEqual(
      expect.objectContaining({
        audioMimeType: "audio/mpeg",
        audioUrl: expect.stringContaining("/api/projects/asset/"),
      }),
    );
  });

  it("maps the fastest audio setting to a thirty percent rate boost", async () => {
    const projectRoot = join(tempDir, "demo");
    await mkdir(join(projectRoot, ".threads", "sess-1"), { recursive: true });
    const repo = createRepo([]);
    const hook = new RecapTurnFinishedHook({
      agentRunner: createRunner(),
      webchatRecapRepo: repo,
      settingsRepo: {
        get: rs.fn(async (key: string) => {
          if (key === "recap.createAudio") return true;
          if (key === "recap.audioSpeed") return "fastest";
          return "medium";
        }),
      },
      logger: { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() },
    });

    await hook.onAgentTurnFinished(
      createEvent({
        turn: {
          ...createEvent().turn,
          threadContext: {
            ...createEvent().turn.threadContext!,
            threadPath: join(projectRoot, ".threads", "sess-1"),
          },
        },
      }),
    );

    expect(ttsConfigs[0]).toEqual(
      expect.objectContaining({
        rate: "+30%",
      }),
    );
  });

  it("surfaces forked recap errors", async () => {
    await expect(
      runForkedRecapTurn(createRunner([{ type: "error", error: "failed" }]), createEvent()),
    ).rejects.toThrow("failed");
  });
});

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { AgentEvent } from "../types.js";
import type { UsageFunding } from "../usage/events.js";
import type { TurnUsageFacts } from "../usage/recorder.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { createSessionFromRun, type ModelProvider } from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";

const AGENT = "usage_agent";
const key = { agentName: AGENT, channelThreadKey: "webchat:usage-test" };

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Consume the turn to its end.
  }
}

describe("AgentSession turn usage", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
  let recorded: TurnUsageFacts[];
  // Each run decides whether it reaches the provider. One that does mints a
  // provider turn id, like Codex does on turn/start.
  let nextRun: () => AsyncIterable<AgentEvent>;
  let providerTurnId: string | undefined;
  let forkable: boolean;
  let funding: UsageFunding;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-usage-"));
    await writeFile(
      join(directory, `${AGENT}.yaml`),
      JSON.stringify({
        name: AGENT,
        description: "Usage recording fixture",
        provider: "openai",
        tier: "medium",
        systemPromptPrefix: "Complete the task.",
        tools: [],
        permissionMode: "default",
      }),
    );
    const loader = new AgentLoader();
    await loader.loadAll(directory);
    testDb = createTestDb();
    recorded = [];
    providerTurnId = undefined;
    forkable = false;
    funding = "byok";
    const provider: ModelProvider = {
      id: "openai",
      displayName: "openai",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        const session = createSessionFromRun("openai", () => nextRun(), params);
        Object.defineProperty(session, "lastProviderTurnId", { get: () => providerTurnId });
        Object.defineProperty(session, "funding", { get: () => funding });
        if (forkable) {
          session.fork = async (fork) => ({
            providerId: "openai",
            sessionId: fork.sessionId,
            sourceSessionId: "source-session",
            mode: fork.mode ?? "ephemeral",
            providerThreadId: "fork-thread",
            open: async () => createSessionFromRun("openai", () => nextRun(), params),
          });
        }
        return session;
      },
    };
    const state = {
      codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
      claude: { loggedIn: false, quotaExhausted: false },
    };
    const actionRegistry = new ActionRegistryImpl([]);
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("Usage test prompt");
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager: new SessionManager(new SessionsRepository(testDb.db)),
        promptBuilder,
        actionRegistry,
        actionEngine: new ActionEngine(actionRegistry),
        modelResolver: createModelResolver({
          providers: [provider],
          aiToolState: { get: () => state, refresh: async () => state },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
        usageRecorder: { recordTurn: (facts) => recorded.push(facts) },
      },
      { keepAliveAcrossTurns: true },
    );
  });

  afterEach(async () => {
    await manager.shutdown();
    testDb.close();
    await rm(directory, { recursive: true, force: true });
    rs.restoreAllMocks();
  });

  it("records each finished turn once with its accounting, funding, and provider turn id", async () => {
    nextRun = async function* () {
      providerTurnId = "provider-turn-1";
      yield {
        type: "result",
        content: "done",
        accounting: {
          provider: "openai",
          model: "gpt-5.6-terra",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 },
        },
      };
    };
    const session = await manager.acquire(key);
    const handle = session.sendTurn({ prompt: "hello" });
    await drain(handle.events);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      turnId: handle.turnId,
      agentName: AGENT,
      status: "completed",
      provider: "openai",
      funding: "byok",
      providerTurnId: "provider-turn-1",
      accounting: { usage: { inputTokens: 10, outputTokens: 5 } },
    });
  });

  it("does not hand a turn that never reached the provider the previous turn's id", async () => {
    let calls = 0;
    nextRun = async function* () {
      calls++;
      if (calls === 1) {
        providerTurnId = "provider-turn-1";
        yield { type: "result", content: "done" };
        return;
      }
      yield { type: "error", error: "rejected before the provider" };
    };
    const session = await manager.acquire(key);
    await drain(session.sendTurn({ prompt: "first" }).events);
    await drain(session.sendTurn({ prompt: "second" }).events);

    expect(recorded.map((facts) => [facts.status, facts.providerTurnId])).toEqual([
      ["completed", "provider-turn-1"],
      ["error", undefined],
    ]);
  });

  it("does not hand a queued turn that never reached the provider the turn ahead's id", async () => {
    let calls = 0;
    nextRun = async function* () {
      calls++;
      if (calls === 1) {
        providerTurnId = "provider-turn-1";
        yield { type: "result", content: "done" };
        return;
      }
      yield { type: "error", error: "rejected before the provider" };
    };
    const session = await manager.acquire(key);
    const first = session.sendTurn({ prompt: "first" });
    const second = session.sendTurn({ prompt: "second" });
    await Promise.all([drain(first.events), drain(second.events)]);

    expect(recorded.map((facts) => [facts.status, facts.providerTurnId])).toEqual([
      ["completed", "provider-turn-1"],
      ["error", undefined],
    ]);
  });

  it("keeps funding from the turn's payer when the payer changes during it", async () => {
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    nextRun = async function* () {
      firstStarted();
      await firstRelease;
      yield { type: "error", error: "Codex exited" };
    };

    const session = await manager.acquire(key);
    const first = session.sendTurn({ prompt: "ChatGPT-funded" });
    await firstStartedPromise;
    funding = "rome_credits";
    releaseFirst();
    await drain(first.events);

    let releaseSecond!: () => void;
    const secondRelease = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    nextRun = async function* () {
      secondStarted();
      await secondRelease;
      yield { type: "error", error: "Codex exited" };
    };

    const second = session.sendTurn({ prompt: "Credit-funded" });
    await secondStartedPromise;
    funding = "subscription";
    releaseSecond();
    await drain(second.events);

    expect(recorded.map((facts) => facts.funding)).toEqual(["byok", "rome_credits"]);
  });

  it("keeps a forked turn's outcome when the consumer stops at its terminal block", async () => {
    forkable = true;
    nextRun = async function* () {
      yield {
        type: "result",
        content: "done",
        accounting: {
          provider: "openai",
          model: "gpt-5.6-terra",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      };
    };
    const session = await manager.acquire(key);
    for await (const event of session.runForkedTurn!({ prompt: "side question" })) {
      if (event.type === "result") break;
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      romeSessionType: "fork",
      status: "completed",
      accounting: { usage: { inputTokens: 10, outputTokens: 5 } },
    });
  });

  it("records a forked turn under its fork session", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.acquire(key);
    const events = session.runForkedTurn!({ prompt: "side question" });
    let forkSessionId: string | undefined;
    for await (const event of events) {
      if (event.type === "turn_start") forkSessionId = event.sessionId;
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      romeSessionId: forkSessionId,
      romeSessionType: "fork",
      // The fixture provider cannot fork, so the forked turn fails.
      status: "error",
      funding: "byok",
    });
  });
});

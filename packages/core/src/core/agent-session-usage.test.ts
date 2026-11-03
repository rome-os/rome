import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/helpers.js";
import type { AgentEvent } from "../types.js";
import type { UsageFunding } from "../usage/events.js";
import type { TurnUsageFacts } from "../usage/recorder.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelSessionForkOpenParams,
} from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";
import type { TurnMiddlewareChain } from "./turn-middleware.js";
import type { AIToolStateValue } from "./ai-tool-state.js";
import type { FacadeToolDef } from "./mcp-facade.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { testChannelSurface } from "../test/channel-surface.js";

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
  let beforeModelDispatch: (() => Promise<void>) | undefined;
  // Whether the model resolver sees Rome credits paying.
  let resolverUsesRomeCredits: boolean;
  let state: AIToolStateValue;
  let providerCalls: number;
  let lifecycle: ReturnType<typeof createAgentLifecycleDispatcher>;
  // Session tools the agent carries, and the params a fork's session opened with.
  let sessionTools: FacadeToolDef[];
  let forkOpenParams: ModelSessionForkOpenParams | undefined;

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
    const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    const loader = new AgentLoader(artifactIdentity);
    await loader.loadAll(directory);
    testDb = createTestDb();
    recorded = [];
    providerTurnId = undefined;
    forkable = false;
    funding = "byok";
    beforeModelDispatch = undefined;
    resolverUsesRomeCredits = false;
    providerCalls = 0;
    const provider: ModelProvider = {
      id: "openai",
      displayName: "openai",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        const session = createSessionFromRun(
          "openai",
          () => {
            providerCalls++;
            return nextRun();
          },
          params,
        );
        Object.defineProperty(session, "lastProviderTurnId", { get: () => providerTurnId });
        Object.defineProperty(session, "funding", { get: () => funding });
        if (forkable) {
          session.fork = async (fork) => ({
            providerId: "openai",
            sessionId: fork.sessionId,
            sourceSessionId: "source-session",
            mode: fork.mode ?? "ephemeral",
            providerThreadId: "fork-thread",
            open: async (opened) => {
              forkOpenParams = opened;
              return createSessionFromRun("openai", () => nextRun(), params);
            },
          });
        }
        return session;
      },
    };
    state = {
      codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
      claude: { loggedIn: false, quotaExhausted: false },
    };
    lifecycle = createAgentLifecycleDispatcher();
    sessionTools = [];
    forkOpenParams = undefined;
    const actionRegistry = new ActionRegistryImpl();
    const promptBuilder = new PromptBuilder();
    const sessionsRepo = new SessionsRepository(testDb.db);
    rs.spyOn(promptBuilder, "build").mockReturnValue("Usage test prompt");
    const turnMiddleware: TurnMiddlewareChain = {
      loadFromCatalog: async () => [],
      run: async (_ctx, terminal) => {
        await beforeModelDispatch?.();
        await terminal();
      },
      size: () => 1,
    };
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager: new SessionManager(sessionsRepo, artifactIdentity),
        sessionsRepo,
        promptBuilder,
        actionRegistry,
        actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
        modelResolver: createModelResolver({
          providers: [provider],
          aiToolState: { get: () => state, refresh: async () => state },
          romeCreditsPayer: { isUsingRomeCredits: () => resolverUsesRomeCredits },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(artifactIdentity),
        lifecycleDispatcher: lifecycle,
        channelSurface: testChannelSurface,
        turnMiddleware,
        usageRecorder: { recordTurn: (facts) => recorded.push(facts) },
        sessionTools: async () => sessionTools,
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
      agentName: `core:${AGENT}`,
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
    resolverUsesRomeCredits = true;
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

  it("dispatches a turn whose funding label resolves without a payer change", async () => {
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let preparationStarted!: () => void;
    const preparationStartedPromise = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    beforeModelDispatch = async () => {
      preparationStarted();
      await preparationGate;
    };
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    funding = "unknown";

    const session = await manager.acquire(key);
    const turn = session.sendTurn({ prompt: "boot-time turn" });
    await preparationStartedPromise;
    // The first status probe lands; Codex's payer is still ChatGPT.
    funding = "subscription";
    releasePreparation();
    await drain(turn.events);

    expect(providerCalls).toBe(1);
    expect(recorded.map((facts) => facts.funding)).toEqual(["subscription"]);
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

  // Listeners such as the Concierge's task review start work on a turn's end,
  // so a fork that announced its own would schedule itself again. The review
  // writes the task list from the fork, so those tools must still act there.
  it("announces no turn start or end for an exact fork, which acts only with fork-safe session tools", async () => {
    forkable = true;
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const tool = (name: string): FacadeToolDef => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      handler: async () => ({ content: [{ type: "text", text: `ran ${name}` }] }),
    });
    sessionTools = ["say", "task_upsert", "task_list", "chat_read", "chat_send"].map(tool);
    const started = rs.spyOn(lifecycle, "dispatchStarted");
    const finished = rs.spyOn(lifecycle, "dispatchFinished");
    const session = await manager.acquire(key);
    await drain(session.runForkedTurn!({ prompt: "review", mode: "exact" }));

    expect(recorded.map((facts) => facts.romeSessionType)).toEqual(["fork"]);
    expect(started).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    const answers: Record<string, string> = {};
    for (const forked of forkOpenParams?.sessionTools ?? []) {
      const result = await forked.handler({});
      answers[forked.name] = (result.content[0] as { text: string }).text;
    }
    expect(answers).toEqual({
      say: "say is unavailable in a forked turn.",
      task_upsert: "ran task_upsert",
      task_list: "ran task_list",
      chat_read: "ran chat_read",
      chat_send: "chat_send is unavailable in a forked turn.",
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

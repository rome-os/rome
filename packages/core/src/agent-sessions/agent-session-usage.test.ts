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
import { AgentLoader } from "../core/agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { sessionBehind, type LoggedTurn, type SessionLog } from "./agent-session.js";
import { turnFacts, withTurnExecution } from "./turn-context.js";
import { createSessionFromRun, type ModelProvider } from "../core/agent-runner.js";
import { createTestSessionManager, type TestSessionManager } from "../test/session-compat.js";
import { CapabilityDiscovery } from "../core/capability-discovery.js";
import { createModelResolver } from "../core/model-resolver.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "../core/skill-catalog.js";
import type { TurnMiddlewareChain } from "./turn-middleware.js";
import type { AIToolStateValue } from "../core/ai-tool-state.js";
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
  let manager: TestSessionManager;
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
  let deps: Parameters<typeof createTestSessionManager>[0];
  let beforeOpen: (() => Promise<void>) | undefined;

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
    beforeOpen = undefined;
    const provider: ModelProvider = {
      id: "openai",
      displayName: "openai",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        await beforeOpen?.();
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
            open: async () => createSessionFromRun("openai", () => nextRun(), params),
          });
        }
        return session;
      },
    };
    state = {
      codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
      claude: { loggedIn: false, quotaExhausted: false },
    };
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
    deps = {
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
      lifecycleDispatcher: createAgentLifecycleDispatcher(),
      channelSurface: testChannelSurface,
      turnMiddleware,
      usageRecorder: { recordTurn: (facts) => recorded.push(facts) },
    };
    manager = createTestSessionManager(deps, { keepAliveAcrossTurns: true });
  });

  afterEach(async () => {
    await manager.shutdown();
    testDb.close();
    await rm(directory, { recursive: true, force: true });
    rs.restoreAllMocks();
  });

  it("replies to the surface its own opener lent, when another opener of the session came after", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const logged: LoggedTurn[] = [];
    const log: SessionLog = {
      turn: (turn) => {
        logged.push(turn);
        return { conversation: { romeSessionId: turn.sessionId, romeSessionType: "action" } };
      },
    };
    const shared = createTestSessionManager({ ...deps, log }, { keepAliveAcrossTurns: true });
    try {
      const caller = "place:test:one";
      const inbox = await shared.open(AGENT, caller, {
        cards: false,
        replies: { channel: "inbox", threadId: "t-1" },
      });
      // A second opener of the same caller lends its own surface before the
      // first one starts its turn.
      const wake = await shared.open(AGENT, caller, {
        cards: false,
        replies: { channel: "wake", threadId: "t-1" },
      });
      expect(wake.sessionId).toBe(inbox.sessionId);

      await drain(inbox.sendTurn({ prompt: "from the inbox" }).events);
      await drain(wake.sendTurn({ prompt: "from the wake" }).events);

      expect(logged.map((turn) => [turn.prompt, turn.replies?.channel])).toEqual([
        ["from the inbox", "inbox"],
        ["from the wake", "wake"],
      ]);
    } finally {
      await shared.shutdown();
    }
  });

  it("asks the caller's owner for the model it remembers when a session resumes by id without one", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const asked: string[] = [];
    const resumer = createTestSessionManager(
      {
        ...deps,
        rememberedModel: async (caller) => {
          asked.push(caller);
          return undefined;
        },
      },
      { keepAliveAcrossTurns: true },
    );
    try {
      const first = await resumer.open(AGENT, "chat:remembered", { cards: false });
      await drain(first.sendTurn({ prompt: "hello" }).events);
      await first.close("user");
      expect(asked).toEqual([]);

      await resumer.session(first.sessionId, AGENT, { cards: false });
      expect(asked).toEqual(["chat:remembered"]);
    } finally {
      await resumer.shutdown();
    }
  });

  it("retires a generation whose open was still in flight when a reset came due", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const caller = "place:test:reset";
    const surface = { cards: false };
    const first = await manager.open(AGENT, caller, surface);
    await drain(first.sendTurn({ prompt: "hello" }).events);
    await first.close("user");

    // A cold open of the same caller waits on the provider while the reset
    // comes due.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeOpen = () => gate;
    const pending = manager.open(AGENT, caller, surface);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reset = manager.reset(AGENT, caller, {
      policy: "test",
      when: () => ({ due: true, reason: "test", elapsedMinutes: 1 }),
    });
    release();
    beforeOpen = undefined;
    const stale = await pending;
    await reset;

    const next = await manager.open(AGENT, caller, surface);
    expect(stale.sessionId).toBe(first.sessionId);
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  it("runs a turn without the facts its caller set, so a turn its tools send reads its own", async () => {
    let seen: ReturnType<typeof turnFacts> | undefined;
    nextRun = async function* () {
      seen = turnFacts();
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(AGENT, "place:test:facts", { cards: false });
    const handle = withTurnExecution({ executionId: "outer" }, () =>
      session.sendTurn({ prompt: "hello" }),
    );
    await drain(handle.events);

    expect(seen).toEqual({});
  });

  it("keeps a turn with no reply address without one, when a later opener lent an address", async () => {
    let seen: unknown = "unread";
    const shared = createTestSessionManager(deps, { keepAliveAcrossTurns: true });
    try {
      const caller = "place:test:no-replies";
      const quiet = await shared.open(AGENT, caller, { cards: false });
      await shared.open(AGENT, caller, {
        cards: false,
        replies: { channel: "wake", threadId: "t-1" },
      });
      const behind = sessionBehind(quiet) as unknown as {
        currentTurnThreadContextRef: unknown;
      };
      nextRun = async function* () {
        seen = behind.currentTurnThreadContextRef;
        yield { type: "result", content: "done" };
      };

      await drain(quiet.sendTurn({ prompt: "no address" }).events);

      expect(seen).toBeUndefined();
    } finally {
      await shared.shutdown();
    }
  });

  it("keeps a running turn's inherited shared context when a turn queued behind it names another", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(AGENT, "place:test:shared", { cards: false });
    await drain(session.sendTurn({ prompt: "first", sharedContext: { who: "first" } }).events);

    const behind = sessionBehind(session) as unknown as {
      currentTurnSharedContextRef: unknown;
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    nextRun = async function* () {
      started();
      await gate;
      yield { type: "result", content: "done" };
    };
    const paused = session.sendTurn({ prompt: "inherits" });
    const pausedDone = drain(paused.events);
    await running;
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const queued = session.sendTurn({ prompt: "names its own", sharedContext: { who: "queued" } });

    expect(behind.currentTurnSharedContextRef).toEqual({ who: "first" });
    release();
    await pausedDone;
    await drain(queued.events);
    expect(behind.currentTurnSharedContextRef).toEqual({ who: "queued" });
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

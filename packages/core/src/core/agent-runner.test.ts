import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { AgentRunner } from "./agent-runner.js";
import { AgentLoader } from "./agent-loader.js";
import { SessionManager } from "./session-manager.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { ActionEngine } from "../actions/engine.js";
import {
  MockModelProvider,
  createTestDb,
  installTestSpanHarness,
  type SpanHarness,
  type TestDb,
} from "../test/helpers.js";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { sessions } from "../db/schema.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { MODEL_MAP, type ForkRunParams } from "./types.js";
import { createActiveSubagentRegistry } from "./active-subagent-registry.js";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { createSubagentExecutionService } from "./subagent-execution.js";
import type { AgentMessage } from "../types.js";
import { join } from "node:path";
import { actionExecutionContext } from "../actions/context.js";
import type { AppCatalog } from "../apps/catalog.js";
import {
  claimLegacyArtifactName,
  createEmptyLegacyArtifactBindings,
  formatArtifactId,
} from "../apps/artifact-id.js";
import * as pathsModule from "../paths.js" with { rstest: "importActual" };

rs.mock("../paths.js", () => ({
  ...pathsModule,
  getProjectRoot: rs.fn(() => "/tmp/agent-runner-test"),
  getDefaultAgentWorkingDir: rs.fn(() => "/tmp/default-project"),
  ensureDefaultAgentWorkingDir: rs.fn(async () => "/tmp/default-project"),
  getProfileDir: rs.fn(() => "/tmp/agent-runner-test/profile"),
  getProfileMemoryDir: rs.fn(() => "/tmp/agent-runner-test/memory"),
  getProfileInstalledAppsDir: rs.fn(() => "/tmp/agent-runner-test/installed-apps"),
}));

import { PromptBuilder } from "./prompt-builder.js";
import { createSessionFromRun, createNullModelSession } from "./agent-runner.js";
import type {
  ModelProvider,
  ModelSession,
  ModelSessionForkParams,
  ModelSessionForkOpenParams,
  ModelSessionParams,
  ProviderId,
} from "./agent-runner.js";
import { createModelResolver, type ModelResolver } from "./model-resolver.js";
import {
  createAgentSessionManager,
  type AgentSession,
  type AgentSessionManager,
  type AgentTurnHandle,
} from "./agent-session.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { createTurnMiddlewareChain } from "./turn-middleware.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { SkillCatalog } from "./skill-catalog.js";
import type { AgentLifecycleDispatcher } from "./agent-lifecycle.js";
import type {
  AgentTurnFinishedEvent,
  AgentTurnStartedEvent,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";

function createTestModelResolver({ providers }: { providers: ModelProvider[] }) {
  return createModelResolver({
    providers,
    aiToolState: {
      get: () => ({
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      }),
      refresh: async () => ({
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      }),
    },
  });
}

function makeOpenSessionFromRun(
  providerId: ProviderId,
  run: (params: import("./agent-runner.js").ModelRunParams) => AsyncIterable<AgentMessage>,
): (params: ModelSessionParams) => Promise<import("./agent-runner.js").ModelSession> {
  return async (params) => createSessionFromRun(providerId, run, params);
}

const FIXTURES_DIR = join(import.meta.dirname, "..", "test", "fixtures", "agents");

/** Collect all messages from an async iterable into an array. */
async function collectMessages(iterable: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const msg of iterable) {
    messages.push(msg);
  }
  return messages;
}

describe("AgentRunner", () => {
  let testDb: TestDb;
  let agentLoader: AgentLoader;
  let sessionManager: SessionManager;
  let promptBuilder: PromptBuilder;
  let actionRegistry: ActionRegistryImpl;
  let actionEngine: ActionEngine;
  let mockProvider: MockModelProvider;

  beforeEach(async () => {
    // Default: providers are healthy (not revoked) so the auth-revoked
    // short-circuit never fires unless a test opts in.

    testDb = createTestDb();
    const repo = new SessionsRepository(testDb.db);

    agentLoader = new AgentLoader();
    await agentLoader.loadAll(FIXTURES_DIR);

    sessionManager = new SessionManager(repo);
    promptBuilder = new PromptBuilder();
    actionRegistry = new ActionRegistryImpl([]);
    actionEngine = new ActionEngine(actionRegistry);
    mockProvider = new MockModelProvider();
  });

  afterEach(() => {
    testDb.close();
  });

  it("mock sessions reject fork with a clear unsupported error", async () => {
    const session = createSessionFromRun("mock", async function* () {}, {
      model: "mock-model",
      systemPrompt: "system",
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      sessionId: "mock-session",
      isNewSession: true,
      executeAction: async () => ({ ok: true }),
      executeSubagent: async () => "delegated",
    });

    await expect(session.fork({ sessionId: "fork-session" })).rejects.toThrow(
      "ModelSession fork is not supported by this provider",
    );
    await session.close();
  });

  it("code-backed null session parks until close and never resumes a provider", async () => {
    const session = createNullModelSession({
      model: "code-backed",
      systemPrompt: "unused",
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      sessionId: "null-session",
      isNewSession: false, // the reuse case that broke a real provider resume
      executeAction: async () => ({ ok: true }),
      executeSubagent: async () => "delegated",
    });
    expect(session.providerId).toBe("mock");
    expect(session.providerThreadId).toBeUndefined();

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
    // must terminate rather than hang: a fallback text + result land on events.
    const session = createNullModelSession({
      model: "code-backed",
      systemPrompt: "unused",
      getActionCatalog: () => [],
      getSkillCatalog: () => [],
      subagentTools: [],
      sessionId: "null-session-2",
      isNewSession: true,
      executeAction: async () => ({ ok: true }),
      executeSubagent: async () => "delegated",
    });
    const drained: AgentMessage[] = [];
    const collector = (async () => {
      for await (const msg of session.events) drained.push(msg);
    })();
    await session.sendUserInput({ text: "anything" });
    await session.close();
    await collector;
    expect(drained.map((m) => m.type)).toEqual(["text", "result"]);
  });

  it("reuses a code-backed session across acquires without resolving a provider", async () => {
    // A code-backed session's null model session reports providerId "mock", but
    // the resolved active provider is real (here "anthropic"). The reuse check
    // must NOT compare those — otherwise webchat (which reacquires on every send)
    // would close + reopen the session every turn, churning the session id and a
    // DB row each time. Regression guard for the canReuseProviderSnapshot
    // code-backed short-circuit.
    const anthropic: ModelProvider = {
      id: "anthropic",
      displayName: "Claude",
      builtinTools: new Set<string>(),
      // A code-backed agent never opens a provider query; if reuse breaks and the
      // session is reopened, this would still not run (null session), so the only
      // observable symptom is a new session instance/id — which we assert against.
      openSession: async () => {
        throw new Error("code-backed agent must not open a provider session");
      },
    };
    const modelResolver = createTestModelResolver({
      providers: [anthropic],
    });
    const manager = createAgentSessionManager(managerDeps(modelResolver));

    // Webchat retains long-lived conversation semantics across reacquires.
    const key = {
      agentName: "test-code-backed",
      channelThreadKey: "webchat:session-reuse:large-model:opus",
    };
    const first = await manager.acquire(key);
    const second = await manager.acquire(key);

    // Same live instance, same session id — not closed + reopened.
    expect(second).toBe(first);
    expect(second.sessionId).toBe(first.sessionId);

    await first.close("shutdown");
  });

  it("canonicalizes a legacy agent name before keying and persisting a session", async () => {
    const legacyBindings = createEmptyLegacyArtifactBindings();
    const namespacedLoader = new AgentLoader({ legacyBindings });
    await namespacedLoader.loadAll(FIXTURES_DIR);
    const namespacedSessionManager = new SessionManager(new SessionsRepository(testDb.db), {
      legacyBindings,
    });
    const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
    const modelResolver = createTestModelResolver({ providers: [provider] });
    const manager = createAgentSessionManager({
      ...managerDeps(modelResolver),
      agentLoader: namespacedLoader,
      sessionManager: namespacedSessionManager,
    });

    const session = await manager.acquire({
      agentName: "test-main",
      channelThreadKey: "webchat:canonical-agent",
    });

    expect(session.key.agentName).toBe("core:test-main");
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.id, session.sessionId));
    expect(row?.agentName).toBe("core:test-main");

    await session.close("shutdown");
  });

  it("runs a forked turn from the matching live source session", async () => {
    const inputs: Array<{ prompt: string; tier?: string }> = [];
    const source = {
      key: { agentName: "test-main", channelThreadKey: "webchat:sess-1" },
      sessionId: "source-session",
      status: "idle" as const,
      sendTurn: rs.fn(),
      async *runForkedTurn(input: { prompt: string; tier?: string }) {
        inputs.push(input);
        yield { type: "result", content: "Fork summary", agent: "test-main" } as const;
      },
      subscribe: rs.fn(() => () => undefined),
      onStatusChange: rs.fn(() => () => undefined),
      interrupt: rs.fn(async () => undefined),
      close: rs.fn(async () => undefined),
    };
    const manager = {
      acquire: rs.fn(),
      peek: rs.fn(() => source),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const runner = new AgentRunner(manager);

    const messages = await collectMessages(
      runner.runForked({
        agentName: "test-main",
        sourceSessionId: "source-session",
        channelThreadKey: "webchat:sess-1",
        prompt: "summarize",
        tier: "small",
      }),
    );

    expect(inputs).toEqual([{ prompt: "summarize", tier: "small" }]);
    expect(messages).toEqual([{ type: "result", content: "Fork summary", agent: "test-main" }]);
  });

  it("records a forked run as a fork rome session with parent lineage", async () => {
    const testDb = createTestDb();
    try {
      const repo = new WebChatRepository(testDb.db);
      await repo.createSession("parent-chat", "Fixing the build");

      const source = {
        key: { agentName: "main", channelThreadKey: "webchat:parent-chat" },
        sessionId: "source-session",
        status: "idle" as const,
        sendTurn: rs.fn(),
        async *runForkedTurn(input: { prompt: string }) {
          yield {
            type: "turn_start",
            turnId: "fork-turn",
            sessionId: "fork-session",
            userPrompt: input.prompt,
            agent: "main",
          } as const;
          yield { type: "text", content: "thinking it over", agent: "main" } as const;
          yield { type: "result", content: "Fork summary", agent: "main" } as const;
          yield {
            type: "turn_end",
            turnId: "fork-turn",
            status: "completed",
            durationMs: 5,
            agent: "main",
          } as const;
        },
        subscribe: rs.fn(() => () => undefined),
        onStatusChange: rs.fn(() => () => undefined),
        interrupt: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager = {
        acquire: rs.fn(),
        peek: rs.fn(() => source),
        shutdown: rs.fn(async () => undefined),
      } as unknown as AgentSessionManager;
      const runner = new AgentRunner(manager, undefined, repo);

      const messages = await collectMessages(
        runner.runForked({
          agentName: "main",
          sourceSessionId: "source-session",
          channelThreadKey: "webchat:parent-chat",
          prompt: "summarize",
          threadContext: {
            channel: "webchat",
            threadId: "parent-chat",
            threadName: "Fixing the build",
            threadType: "private",
          },
          parentTurnId: "parent-turn-1",
          label: "recap",
        }),
      );
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "text", "result", "turn_end"]);

      const forkSession = await repo.getSession("fork-session");
      expect(forkSession).toMatchObject({
        type: "fork",
        name: "recap: Fixing the build",
        agentName: null,
        parentSessionId: "parent-chat",
        parentTurnId: "parent-turn-1",
        triggerKind: "fork",
        triggerName: "recap",
        sourceChannel: "webchat",
        sourceThreadId: "parent-chat",
      });

      const transcript = await repo.getMessages("fork-session");
      expect(transcript.map((m) => m.role)).toEqual(["user", "trace", "assistant"]);
      const trace = await repo.getTraceContentByTurn("fork-session", "fork-turn");
      expect(JSON.parse(trace?.content ?? "[]").map((b: { type: string }) => b.type)).toEqual([
        "turn_start",
        "text",
        "result",
        "turn_end",
      ]);
    } finally {
      testDb.close();
    }
  });

  it("publishes forked runs for live session inspection", async () => {
    const source = {
      key: { agentName: "main", channelThreadKey: "webchat:parent-chat" },
      sessionId: "source-session",
      status: "idle" as const,
      sendTurn: rs.fn(),
      async *runForkedTurn(input: { prompt: string }) {
        yield {
          type: "turn_start",
          turnId: "fork-turn",
          sessionId: "fork-session",
          userPrompt: input.prompt,
          agent: "main",
        } as const;
        yield { type: "text_delta", content: "Learning", agent: "main" } as const;
        yield { type: "result", content: "Preference saved", agent: "main" } as const;
        yield {
          type: "turn_end",
          turnId: "fork-turn",
          status: "completed",
          durationMs: 5,
          agent: "main",
        } as const;
      },
      subscribe: rs.fn(() => () => undefined),
      onStatusChange: rs.fn(() => () => undefined),
      interrupt: rs.fn(async () => undefined),
      close: rs.fn(async () => undefined),
    };
    const manager = {
      acquire: rs.fn(),
      peek: rs.fn(() => source),
      shutdown: rs.fn(async () => undefined),
    } as unknown as AgentSessionManager;
    const turnStreams = createAgentTurnStreamRegistry();
    const runner = new AgentRunner(manager, undefined, undefined, turnStreams);
    const iterator = runner
      .runForked({
        agentName: "main",
        sourceSessionId: "source-session",
        channelThreadKey: "webchat:parent-chat",
        prompt: "learn from this feedback",
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "turn_start", sessionId: "fork-session", turnId: "fork-turn" },
    });
    const active = turnStreams.get("fork-turn");
    expect(active).toBeDefined();
    expect(active?.sessionId).toBe("fork-session");
    expect(active?.interrupt).toBeUndefined();
    expect(active?.messages().map((message) => message.type)).toEqual(["turn_start"]);

    await iterator.next();
    expect(active?.messages().map((message) => message.type)).toEqual(["turn_start", "text_delta"]);
    while (!(await iterator.next()).done) {
      // Drain the remainder so AgentRunner closes the live stream in `finally`.
    }

    expect(active?.finished).toBe(true);
    expect(active?.messages().map((message) => message.type)).toEqual([
      "turn_start",
      "text_delta",
      "result",
      "turn_end",
    ]);
    expect(turnStreams.listBySession("fork-session")).toEqual([]);
  });

  /** Provider whose live sessions support fork(); each fork opens the
   *  session produced by `makeForkSession` (which receives the open params
   *  so tests can inspect the fork's tool surface). */
  function withForkSupport(
    provider: MockModelProvider,
    makeForkSession: (openParams: ModelSessionForkOpenParams) => ModelSession,
    options: {
      providerThreadId?: string;
      onFork?: (params: ModelSessionForkParams) => void;
    } = {},
  ): MockModelProvider {
    const baseOpen = provider.openSession.bind(provider);
    provider.openSession = async (params: ModelSessionParams) => {
      const session = await baseOpen(params);
      return {
        ...session,
        providerThreadId: options.providerThreadId,
        fork: async (forkParams: ModelSessionForkParams) => {
          options.onFork?.(forkParams);
          return {
            providerId: "mock" as const,
            sessionId: forkParams.sessionId,
            sourceSessionId: params.sessionId,
            sourceProviderThreadId: options.providerThreadId,
            mode: "ephemeral" as const,
            open: async (openParams: ModelSessionForkOpenParams) => makeForkSession(openParams),
          };
        },
      };
    };
    return provider;
  }

  function forkSessionStub(overrides: Partial<ModelSession>): ModelSession {
    return {
      providerId: "mock",
      model: "mock-model",
      events: (async function* (): AsyncIterable<AgentMessage> {})(),
      async sendUserInput() {},
      async fork() {
        throw new Error("nested fork unsupported");
      },
      async interrupt() {},
      async close() {},
      ...overrides,
    };
  }

  /** Run one normal turn to make the source session live, then fork it. */
  async function runForkAgainstLiveSession(
    makeForkSession: (openParams: ModelSessionForkOpenParams) => ModelSession,
    opts: {
      provider?: MockModelProvider;
      agentName?: string;
      fork?: Partial<Omit<ForkRunParams, "agentName" | "sourceSessionId" | "channelThreadKey">>;
      sourceProviderThreadId?: string;
      onFork?: (params: ModelSessionForkParams) => void;
      appCatalog?: Pick<AppCatalog, "get">;
    } = {},
  ): Promise<AgentMessage[]> {
    const agentName = opts.agentName ?? "test-main";
    const provider = withForkSupport(
      opts.provider ?? new MockModelProvider([[{ type: "result", content: "Done" }]]),
      makeForkSession,
      { providerThreadId: opts.sourceProviderThreadId, onFork: opts.onFork },
    );
    const runner = createRunner(provider, undefined, {
      keepAliveAcrossTurns: true,
      appCatalog: opts.appCatalog,
    });
    const first = await collectMessages(
      runner.run({ agentName, prompt: "Hi", channelThreadKey: "webchat:fork-1" }),
    );
    const start = first.find((m) => m.type === "turn_start") as { sessionId: string };
    return collectMessages(
      runner.runForked({
        agentName,
        sourceSessionId: start.sessionId,
        channelThreadKey: "webchat:fork-1",
        prompt: "fork it",
        ...opts.fork,
      }),
    );
  }

  describe("forked turn bracketing", () => {
    it("validates and forwards the selected provider checkpoint", async () => {
      let providerFork: ModelSessionForkParams | undefined;
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield { type: "result", content: "Fork complete" };
            })(),
          }),
        {
          sourceProviderThreadId: "provider-thread",
          onFork: (params) => {
            providerFork = params;
          },
          fork: {
            mode: "exact",
            sourceCheckpoint: {
              providerId: "mock",
              providerThreadId: "provider-thread",
              checkpointId: "provider-turn-t2",
            },
          },
        },
      );

      expect(messages.map((message) => message.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(providerFork).toMatchObject({
        configurationMode: "exact",
        sourceCheckpoint: "provider-turn-t2",
      });
    });

    it("rejects a checkpoint from a different provider thread", async () => {
      const onFork = rs.fn();
      const messages = await runForkAgainstLiveSession(() => forkSessionStub({}), {
        sourceProviderThreadId: "live-provider-thread",
        onFork,
        fork: {
          sourceCheckpoint: {
            providerId: "mock",
            providerThreadId: "different-provider-thread",
            checkpointId: "provider-turn-t2",
          },
        },
      });

      expect(messages.map((message) => message.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({
        type: "error",
        error: "Fork checkpoint belongs to a different provider thread",
      });
      expect(onFork).not.toHaveBeenCalled();
    });

    it("keeps fork sources leased and resumes them after idle eviction", async () => {
      rs.useFakeTimers();
      const provider = withForkSupport(
        new MockModelProvider([[{ type: "result", content: "Source ready" }]]),
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield { type: "result", content: "Fork complete" };
            })(),
          }),
      );
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true, idleTtlMs: 100 },
      );
      const runner = new AgentRunner(manager);
      const key = { agentName: "test-main", channelThreadKey: "webchat:fork-idle-lease" };
      let firstFork: AsyncIterator<AgentMessage> | undefined;
      let secondFork: AsyncIterator<AgentMessage> | undefined;
      let resumedFork: AsyncIterator<AgentMessage> | undefined;

      try {
        const sourceMessages = await collectMessages(
          runner.run({ ...key, prompt: "Open the source conversation" }),
        );
        const sourceStart = sourceMessages.find((message) => message.type === "turn_start");
        expect(sourceStart).toBeDefined();
        const sourceSessionId = sourceStart!.sessionId;

        firstFork = runner
          .runForked({
            ...key,
            sourceSessionId,
            prompt: "First side chat",
            mode: "exact",
          })
          [Symbol.asyncIterator]();
        await expect(firstFork.next()).resolves.toMatchObject({
          done: false,
          value: { type: "turn_start" },
        });

        // Production evicts otherwise-idle source sessions after 15 seconds.
        // Cross several sweeper intervals while the first fork is leased: the
        // source must remain available for another side chat.
        await rs.advanceTimersByTimeAsync(500);
        expect(manager.peek(key)?.sessionId).toBe(sourceSessionId);

        secondFork = runner
          .runForked({
            ...key,
            sourceSessionId,
            prompt: "Second side chat",
            mode: "exact",
          })
          [Symbol.asyncIterator]();
        await expect(secondFork.next()).resolves.toMatchObject({
          done: false,
          value: { type: "turn_start" },
        });

        await secondFork.return?.();
        await firstFork.return?.();
        await rs.advanceTimersByTimeAsync(200);
        expect(manager.peek(key)).toBeUndefined();

        // The webchat route reacquires before every fork. Webchat's persisted
        // provider-session reuse does not expire, so a later side chat resumes
        // the same source identity after the short in-memory lease is evicted.
        const resumedSource = await manager.acquire(key);
        expect(resumedSource.sessionId).toBe(sourceSessionId);
        resumedFork = runner
          .runForked({
            ...key,
            sourceSessionId,
            prompt: "Side chat after eviction",
            mode: "exact",
          })
          [Symbol.asyncIterator]();
        await expect(resumedFork.next()).resolves.toMatchObject({
          done: false,
          value: { type: "turn_start" },
        });
      } finally {
        await resumedFork?.return?.();
        await secondFork?.return?.();
        await firstFork?.return?.();
        rs.useRealTimers();
        await manager.shutdown();
      }
    });

    it("opens a fork with an explicitly requested model tier", async () => {
      const openParams: ModelSessionForkOpenParams[] = [];
      await runForkAgainstLiveSession(
        (params) => {
          openParams.push(params);
          return forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield { type: "result", content: "Fork summary" };
            })(),
          });
        },
        { fork: { tier: "small" } },
      );

      expect(openParams).toHaveLength(1);
      expect(openParams[0].model).toBe(MODEL_MAP.small);
      // Forks never write pins: the source session keeps the pin of
      // its own live model even after a tier-overridden forked turn ran.
      const row = await new SessionsRepository(testDb.db).findByChannelThreadKey("webchat:fork-1");
      expect(row).toMatchObject({ model: MODEL_MAP.large });
    });

    it("synthesizes error + turn_end when the fork stream ends without a terminal", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<AgentMessage> {
            yield { type: "text", content: "partial fork output" };
          })(),
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "text", "error", "turn_end"]);
      expect(messages[2]).toMatchObject({
        type: "error",
        error: expect.stringContaining("without a terminal"),
      });
      expect(messages[3]).toMatchObject({
        type: "turn_end",
        status: "error",
        turnId: (messages[0] as { turnId: string }).turnId,
        durationMs: expect.any(Number),
      });
    });

    it("synthesizes error + turn_end when sendUserInput on the fork throws", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          async sendUserInput() {
            throw new Error("fork transport exploded");
          },
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({
        type: "error",
        error: "fork transport exploded",
      });
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("brackets fork setup failures with turn_start + error + turn_end", async () => {
      const messages = await runForkAgainstLiveSession(() => {
        throw new Error("fork backend unavailable");
      });

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({ type: "error", error: "fork backend unavailable" });
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("a close-time fork error does not escape after turn_end", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<AgentMessage> {
            yield { type: "result", content: "Fork summary" };
          })(),
          async close() {
            throw new Error("close exploded");
          },
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "completed" });
    });

    it("brackets a user-stopped forked turn with status=interrupted", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<AgentMessage> {
            yield {
              type: "result",
              content: "",
              accounting: {
                provider: "mock",
                model: "mock-model",
                usage: {
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                },
                stopReason: "interrupted",
              },
            };
          })(),
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(messages[2]).toMatchObject({ type: "turn_end", status: "interrupted" });
    });

    it("brackets a successful forked turn with status=completed", async () => {
      const messages = await runForkAgainstLiveSession(() =>
        forkSessionStub({
          events: (async function* (): AsyncIterable<AgentMessage> {
            yield { type: "text", content: "fork output" };
            yield { type: "result", content: "Fork summary" };
          })(),
        }),
      );

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "text", "result", "turn_end"]);
      expect(messages[3]).toMatchObject({ type: "turn_end", status: "completed" });
    });
  });

  describe("forked turn modes", () => {
    function registerDemoAction(
      execute?: (
        args: Record<string, unknown>,
      ) => Promise<import("../actions/types.js").ActionResult>,
    ): void {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Demo action for fork-mode tests",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "read-only",
        },
        inputSchema: {},
        execute: execute ?? (async () => ({ status: "ok" })),
      });
    }

    it("default forks open an isolated tool surface with execution disabled", async () => {
      registerDemoAction();
      let forkOpen: ModelSessionForkOpenParams | undefined;
      const messages = await runForkAgainstLiveSession((openParams) => {
        forkOpen = openParams;
        return forkSessionStub({
          events: (async function* (): AsyncIterable<AgentMessage> {
            yield { type: "result", content: "Fork summary" };
          })(),
        });
      });

      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(forkOpen).toBeDefined();
      expect(forkOpen!.getActionCatalog()).toEqual([]);
      expect(forkOpen!.getSkillCatalog()).toEqual([]);
      expect(forkOpen!.subagentTools).toEqual([]);
      expect(forkOpen!.builtinTools).toEqual([]);
      expect(forkOpen!.reasoningEffort).toBe("high");
      expect(forkOpen!.supportsInteractiveSurface).toBe(false);
      expect(forkOpen!.handback).toBeUndefined();
      await expect(forkOpen!.executeAction("demo_action", {})).rejects.toThrow(
        "Actions are disabled in forked turns",
      );
      await expect(
        forkOpen!.executeSubagent(
          "test-explore",
          { prompt: "x" },
          { toolUseId: "isolated-subagent" },
        ),
      ).rejects.toThrow("Subagents are disabled in forked turns");
    });

    it("preserves App Store attribution on isolated forks", async () => {
      const getRecord = agentLoader.getRecord.bind(agentLoader);
      const recordSpy = rs.spyOn(agentLoader, "getRecord").mockImplementation((name) => {
        const record = getRecord(name);
        if (name !== "test-main") return record;
        return {
          ...record,
          metadata: {
            ...record.metadata,
            ownerType: "app",
            ownerId: "test-app",
          },
        };
      });
      let forkOpen: ModelSessionForkOpenParams | undefined;

      try {
        await runForkAgainstLiveSession(
          (openParams) => {
            forkOpen = openParams;
            return forkSessionStub({
              events: (async function* (): AsyncIterable<AgentMessage> {
                yield { type: "result", content: "Fork summary" };
              })(),
            });
          },
          {
            appCatalog: {
              get: rs.fn((appId: string) =>
                appId === "test-app"
                  ? {
                      source: {
                        mode: "appstore",
                        listingId: "@publisher/test-app",
                        version: "1.0.0",
                      },
                    }
                  : null,
              ),
            } as unknown as Pick<AppCatalog, "get">,
          },
        );

        expect(forkOpen?.appStoreListingId).toBe("@publisher/test-app");
      } finally {
        recordSpy.mockRestore();
      }
    });

    it("exact forks mirror the source session's open configuration", async () => {
      registerDemoAction();
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      provider.builtinTools = new Set(["Read", "Edit", "Bash"]);
      let forkOpen: ModelSessionForkOpenParams | undefined;
      await runForkAgainstLiveSession(
        (openParams) => {
          forkOpen = openParams;
          return forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield { type: "result", content: "Fork summary" };
            })(),
          });
        },
        { provider, fork: { mode: "exact" } },
      );

      const sourceOpen = provider.sessions[0];
      expect(forkOpen).toBeDefined();
      expect(forkOpen!.systemPrompt).toBe(sourceOpen.systemPrompt);
      // Same getter references, not equal copies: both sessions must
      // serialize the same catalog snapshot for the tool block to match.
      expect(forkOpen!.getActionCatalog).toBe(sourceOpen.getActionCatalog);
      expect(forkOpen!.getSkillCatalog).toBe(sourceOpen.getSkillCatalog);
      expect(forkOpen!.getActionCatalog().map((a) => a.name)).toEqual(["demo_action"]);
      expect(forkOpen!.subagentTools).toBe(sourceOpen.subagentTools);
      expect(forkOpen!.subagentTools.map((t) => t.name)).toContain("test-explore");
      // test-main declares Read + Edit; Bash stays provider-only in both.
      expect(forkOpen!.builtinTools).toBe(sourceOpen.builtinTools);
      expect(forkOpen!.builtinTools).toEqual(["Read", "Edit"]);
      // The advertised surface stays identical (prefix identity with the
      // source); only the interactive *runtime* is marked detached, since no
      // webchat drain reads a fork stream.
      expect(forkOpen!.supportsInteractiveSurface).toBe(true);
      expect(forkOpen!.interactiveSurfaceDetached).toBe(true);
      expect(forkOpen!.maxTurns).toBe(sourceOpen.maxTurns);
      expect(forkOpen!.workingDir).toBe(sourceOpen.workingDir);
      expect(forkOpen!.externalMcpServers).toBe(sourceOpen.externalMcpServers);
      expect(forkOpen!.reasoningEffort).toBe(sourceOpen.reasoningEffort);
      // Model follows the source's live model when no tier override is given.
      expect(forkOpen!.model).toBe(sourceOpen.model);
      // Callbacks must be fresh fork-bound closures, never the source's.
      expect(forkOpen!.executeAction).not.toBe(sourceOpen.executeAction);
      expect(forkOpen!.executeSubagent).not.toBe(sourceOpen.executeSubagent);
    });

    it("exact forks execute actions attributed to the fork session, not the source", async () => {
      const observed: Array<{ sessionId?: string; channelUserId?: string }> = [];
      registerDemoAction(async () => {
        const store = actionExecutionContext.getStore();
        observed.push({
          sessionId: store?.sessionId,
          channelUserId: store?.channelContext?.channelUserId,
        });
        return { status: "ok" };
      });

      const messages = await runForkAgainstLiveSession(
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              await openParams.executeAction("demo_action", {});
              yield { type: "result", content: "acted" };
            })(),
          }),
        {
          fork: {
            mode: "exact",
            threadContext: {
              channel: "webchat",
              threadId: "fork-1",
              channelUserId: "guardian-fork",
            },
          },
        },
      );

      const forkStart = messages.find((m) => m.type === "turn_start") as { sessionId: string };
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(observed).toHaveLength(1);
      expect(observed[0].sessionId).toBe(forkStart.sessionId);
      expect(observed[0].channelUserId).toBe("guardian-fork");
    });

    it("exact forks project subagents as first-class lifecycle events", async () => {
      const provider = new MockModelProvider([
        // Source turn, then the fork's subagent (test-explore) turn.
        [{ type: "result", content: "Done" }],
        [
          { type: "text", content: "child thinking" },
          { type: "result", content: "child answer" },
        ],
      ]);

      const messages = await runForkAgainstLiveSession(
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield {
                type: "tool_use",
                id: "fork-subagent-1",
                tool: "test-explore",
                input: { prompt: "dig" },
              };
              const completion = (await openParams.executeSubagent(
                "test-explore",
                { prompt: "dig" },
                { toolUseId: "fork-subagent-1" },
              )) as { output: string };
              yield {
                type: "tool_result",
                toolUseId: "fork-subagent-1",
                tool: "test-explore",
                output: completion,
              };
              yield { type: "result", content: completion.output };
            })(),
          }),
        { provider, fork: { mode: "exact" } },
      );

      const start = messages.find((m) => m.type === "subagent_start");
      expect(start).toMatchObject({
        toolUseId: "fork-subagent-1",
        agentName: "test-explore",
      });
      const childResult = messages.find((m) => m.type === "subagent_result");
      expect(childResult).toMatchObject({
        toolUseId: "fork-subagent-1",
        status: "completed",
        output: "child answer",
      });
      expect(
        messages.some(
          (m) =>
            m.type === "text" && (m as AgentMessage & { agent?: string }).agent === "test-explore",
        ),
      ).toBe(false);
      const terminal = messages.find((m) => m.type === "result");
      expect(terminal).toMatchObject({ content: "child answer" });
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      expect(messages.indexOf(start!)).toBeLessThan(messages.indexOf(terminal!));
    });

    it("exact forks preserve provider-native structured results without a side-channel event", async () => {
      const payload = { decision: "REPLY", reason: "all good" };
      let forkOpen: ModelSessionForkOpenParams | undefined;

      const messages = await runForkAgainstLiveSession(
        (openParams) => {
          forkOpen = openParams;
          return forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield {
                type: "result",
                content: JSON.stringify(payload),
                structuredOutput: payload,
              };
            })(),
          });
        },
        { agentName: "test-structured", fork: { mode: "exact" } },
      );

      expect(forkOpen!.outputSchema).toEqual(
        expect.objectContaining({ type: "object", required: ["decision", "reason"] }),
      );
      expect(forkOpen!.handback).toBeUndefined();
      expect(messages.some((message) => message.type === "structured_output")).toBe(false);
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: JSON.stringify(payload),
        structuredOutput: payload,
      });
    });
    it("exact forks fail closed when a provider omits structured output", async () => {
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield { type: "result", content: "forgot to submit" };
            })(),
          }),
        { agentName: "test-structured", fork: { mode: "exact" } },
      );

      // The same terminal assertion applies to live and forked turns.
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "error", "turn_end"]);
      expect(messages[1]).toMatchObject({
        type: "error",
        error: expect.stringContaining("without structured output"),
      });
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("does not exempt a suspended outputSchema turn from the native result contract", async () => {
      const messages = await runForkAgainstLiveSession(
        () =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield {
                type: "tool_result",
                toolUseId: "tu-fork-park",
                tool: "demo_action",
                output: { pendingApproval: true },
              };
              yield {
                type: "result",
                content: JSON.stringify({ decision: "REPLY", reason: "after approval" }),
                structuredOutput: { decision: "REPLY", reason: "after approval" },
              };
            })(),
          }),
        { agentName: "test-structured", fork: { mode: "exact" } },
      );

      // outputSchema is per provider turn. A suspension makes the contract
      // invalid even if the provider subsequently emits a schema-valid value.
      expect(messages.map((m) => m.type)).toEqual([
        "turn_start",
        "tool_result",
        "error",
        "turn_end",
      ]);
      expect(messages[2]).toMatchObject({
        type: "error",
        error: expect.stringContaining("cannot suspend"),
      });
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("exact fork actions take the non-interactive fallback for interactive results", async () => {
      registerDemoAction(async () => ({
        status: "pending_interaction",
        interaction: {
          appId: "demo-app",
          promptText: "Pick a time slot",
          render: { kind: "inline", componentId: "slot-picker" },
        },
      }));

      let actionResult: unknown;
      const messages = await runForkAgainstLiveSession(
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              actionResult = await openParams.executeAction("demo_action", {});
              yield { type: "result", content: "done" };
            })(),
          }),
        { fork: { mode: "exact" } },
      );

      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
      // No webchat drain reads a fork stream, so the tool_result must not
      // claim a card was mounted — the prose fallback relays the prompt text.
      expect(actionResult).toMatchObject({
        message: expect.stringContaining("cannot render an interactive UI"),
      });
      expect((actionResult as { pendingInteraction?: boolean }).pendingInteraction).toBeUndefined();
      expect((actionResult as { message: string }).message).toContain("Pick a time slot");
    });

    it("exact forks of a handback session reject submit_output instead of claiming guardian review", async () => {
      let forkOpen: ModelSessionForkOpenParams | undefined;
      let submitResponse: unknown;
      const provider = withForkSupport(
        new MockModelProvider([[{ type: "result", content: "Done" }]]),
        (openParams) => {
          forkOpen = openParams;
          return forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              submitResponse = await openParams.executeSubmitOutput!({ answer: "candidate" });
              yield { type: "result", content: "tried to submit" };
            })(),
          });
        },
      );
      const modelResolver = createTestModelResolver({ providers: [provider] });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const runner = new AgentRunner(manager);
      // A conversational-handback source (interactive-summon child session):
      // No config outputSchema; the session-scoped contract wires handback tools.
      const source = await manager.acquire(
        { agentName: "test-main", channelThreadKey: "webchat:handback-fork" },
        {
          handback: {
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      );

      const messages = await collectMessages(
        runner.runForked({
          agentName: "test-main",
          sourceSessionId: source.sessionId,
          channelThreadKey: "webchat:handback-fork",
          prompt: "fork it",
          mode: "exact",
        }),
      );

      // The fork still advertises the source's handback contract
      // (catalog identity with the source)...
      expect(forkOpen!.handback).toBeDefined();
      expect(forkOpen!.outputSchema).toBeUndefined();
      expect(forkOpen!.executeSubmitOutput).toBeDefined();
      // ...but a handback submission is a UI act: no webchat drain persists a
      // submission_card off a fork stream, so accepting it would claim a
      // guardian review that can never happen.
      expect(submitResponse).toMatchObject({
        ok: false,
        error: expect.stringContaining("no guardian approval surface"),
      });
      expect(messages.some((m) => m.type === "structured_output")).toBe(false);
      // Handbacks stay exempt from the fail-closed terminal rule (live
      // parity): the fork's result passes through.
      expect(messages.map((m) => m.type)).toEqual(["turn_start", "result", "turn_end"]);
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
    });

    it("exact fork subagents run in fresh fork-owned child sessions", async () => {
      const provider = withForkSupport(
        new MockModelProvider([
          [{ type: "result", content: "Done" }], // source turn
          [{ type: "result", content: "fork child answer" }], // fork's subagent turn
        ]),
        (openParams) =>
          forkSessionStub({
            events: (async function* (): AsyncIterable<AgentMessage> {
              yield {
                type: "tool_use",
                id: "fork-subagent-2",
                tool: "test-explore",
                input: { prompt: "fork dig" },
              };
              const completion = (await openParams.executeSubagent(
                "test-explore",
                { prompt: "fork dig" },
                { toolUseId: "fork-subagent-2" },
              )) as { output: string };
              yield {
                type: "tool_result",
                toolUseId: "fork-subagent-2",
                tool: "test-explore",
                output: completion,
              };
              yield { type: "result", content: completion.output };
            })(),
          }),
      );
      const modelResolver = createTestModelResolver({ providers: [provider] });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const runner = new AgentRunner(manager);
      const first = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hi", channelThreadKey: "webchat:fork-iso" }),
      );
      const start = first.find((m) => m.type === "turn_start") as { sessionId: string };

      const messages = await collectMessages(
        runner.runForked({
          agentName: "test-main",
          sourceSessionId: start.sessionId,
          channelThreadKey: "webchat:fork-iso",
          prompt: "fork it",
          mode: "exact",
        }),
      );

      // The fork's subagent is always a fresh session owned by the fork.
      const childOpens = provider.sessions.filter((s) => s.agentName === "test-explore");
      expect(childOpens).toHaveLength(1);
      expect(childOpens[0].sessionId).not.toBe(start.sessionId);
      expect(childOpens[0].isNewSession).toBe(true);
      const terminal = messages.find((m) => m.type === "result");
      expect(terminal).toMatchObject({ content: "fork child answer" });
    });
  });

  function createLifecycleRecorder(): AgentLifecycleDispatcher & {
    started: AgentTurnStartedEvent[];
    finished: AgentTurnFinishedEvent[];
  } {
    const started: AgentTurnStartedEvent[] = [];
    const finished: AgentTurnFinishedEvent[] = [];
    return {
      started,
      finished,
      async loadFromCatalog() {
        return [];
      },
      dispatchStarted(event) {
        started.push(event);
        return { invoked: 0, skipped: 0, skips: [] };
      },
      dispatchFinished(event) {
        finished.push(event);
        return { invoked: 0, skipped: 0, skips: [] };
      },
      onFinished() {
        return () => {};
      },
    };
  }

  // Full ManagerDeps over the suite's shared collaborators. CapabilityDiscovery
  // is never start()ed and the default dispatcher has no hooks loaded, so both
  // are real-but-inert.
  function managerDeps(
    modelResolver: ModelResolver,
    lifecycleDispatcher?: AgentLifecycleDispatcher,
    appCatalog?: Pick<AppCatalog, "get">,
  ) {
    const activeSubagentRegistry = createActiveSubagentRegistry();
    const turnStreams = createAgentTurnStreamRegistry();
    return {
      agentLoader,
      appCatalog,
      sessionManager,
      promptBuilder,
      actionRegistry,
      modelResolver,
      actionEngine,
      webchatRepo: new WebChatRepository(testDb.db),
      capabilityDiscovery: new CapabilityDiscovery(),
      skillCatalog: new SkillCatalog(),
      lifecycleDispatcher: lifecycleDispatcher ?? createAgentLifecycleDispatcher(),
      activeSubagentRegistry,
      subagentExecutionService: createSubagentExecutionService({
        webchatRepo: new WebChatRepository(testDb.db),
        activeRegistry: activeSubagentRegistry,
        turnStreams,
      }),
    };
  }

  function createRunner(
    provider?: ModelProvider,
    lifecycleDispatcher?: AgentLifecycleDispatcher,
    options: {
      keepAliveAcrossTurns?: boolean;
      appCatalog?: Pick<AppCatalog, "get">;
      resetPolicy?: ProviderSessionResetPolicy;
    } = {},
  ): AgentRunner {
    const active = provider ?? mockProvider;
    const modelResolver = createTestModelResolver({
      providers: [active],
    });
    const manager = createAgentSessionManager(
      {
        ...managerDeps(modelResolver, lifecycleDispatcher, options.appCatalog),
        ...(options.resetPolicy
          ? { resolveProviderSessionReset: async () => options.resetPolicy! }
          : {}),
      },
      { keepAliveAcrossTurns: options.keepAliveAcrossTurns },
    );
    return new AgentRunner(manager);
  }

  function createClosableModelSession(params: ModelSessionParams): ModelSession {
    let closed = false;
    const resolvers: Array<(item: IteratorResult<AgentMessage>) => void> = [];
    const finish = (): IteratorResult<AgentMessage> => ({ value: undefined as never, done: true });

    return {
      providerId: "mock",
      model: params.model,
      events: {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<AgentMessage>> {
              if (closed) return finish();
              return await new Promise((resolve) => {
                resolvers.push(resolve);
              });
            },
          };
        },
      },
      async sendUserInput(): Promise<void> {},
      async fork() {
        throw new Error("ModelSession fork is not supported by this provider");
      },
      async interrupt(): Promise<void> {},
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        while (resolvers.length > 0) {
          resolvers.shift()!(finish());
        }
      },
    };
  }

  describe("session management", () => {
    it("waits for cancellation before ending a turn stopped during middleware", async () => {
      let releaseMiddleware!: () => void;
      const middlewareGate = new Promise<void>((resolve) => {
        releaseMiddleware = resolve;
      });
      let confirmExit!: () => void;
      const exit = new Promise<void>((resolve) => {
        confirmExit = resolve;
      });
      const turnMiddleware = createTurnMiddlewareChain();
      rs.spyOn(turnMiddleware, "run").mockImplementation(async (_ctx, next) => {
        await middlewareGate;
        await next();
      });
      const interrupt = rs.fn(() => exit);
      const sendUserInput = rs.fn(async () => {});
      rs.spyOn(mockProvider, "openSession").mockImplementation(async (params) => ({
        ...createClosableModelSession(params),
        interrupt,
        sendUserInput,
      }));
      const manager = createAgentSessionManager(
        {
          ...managerDeps(createTestModelResolver({ providers: [mockProvider] })),
          turnMiddleware,
        },
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:stop-middleware",
      });
      const turn = session.sendTurn({ prompt: "Do not dispatch" });
      let finished = false;
      const messages = collectMessages(turn.events).then((value) => {
        finished = true;
        return value;
      });
      await rs.waitFor(() => expect(turnMiddleware.run).toHaveBeenCalled());
      const stopping = turn.interrupt!("user-stop");
      releaseMiddleware();
      await rs.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(2));
      expect(finished).toBe(false);
      expect(sendUserInput).not.toHaveBeenCalled();
      confirmExit();
      await stopping;
      expect(await messages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );
      await manager.shutdown();
    });

    it("cancels a turn before dispatch without sending its input", async () => {
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [mockProvider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:early-stop",
      });
      const turn = session.sendTurn({ prompt: "Do not dispatch" });
      await turn.interrupt!("user-stop");
      const messages = await collectMessages(turn.events);
      expect(mockProvider.calls).toHaveLength(0);
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );
      await manager.shutdown();
    });

    it("reopens an aborted provider through the conversational input lane", async () => {
      const opens: ModelSessionParams[] = [];
      const prompts: string[] = [];
      const cancels = rs.fn();
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const provider: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        async openSession(params) {
          opens.push(params);
          const first = opens.length === 1;
          let disposed = false;
          const model = createSessionFromRun(
            "anthropic",
            async function* ({ prompt }) {
              prompts.push(prompt);
              if (first) {
                yield {
                  type: "tool_use",
                  id: "edit-1",
                  tool: "Edit",
                  input: { file_path: "test.txt" },
                };
                await firstGate;
                yield { type: "result", content: "Work before cancellation" };
                await model.close();
              } else {
                await secondGate;
                yield { type: "result", content: "Next turn" };
              }
            },
            params,
          );
          return {
            ...model,
            providerThreadId: "persisted-claude-thread",
            get isClosed() {
              return disposed;
            },
            async interrupt() {
              cancels();
              disposed = true;
              releaseFirst();
            },
          };
        },
      };
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:abort-resume",
      });
      const submit = (inputId: string, prompt: string) => {
        let resolveTurn!: (handle: AgentTurnHandle) => void;
        const turn = new Promise<AgentTurnHandle>((resolve) => {
          resolveTurn = resolve;
        });
        const receipt = session.submitInput!(
          { inputId, prompt },
          { onTurn: (handle) => resolveTurn(handle) },
        );
        return { receipt, turn };
      };

      const firstInput = submit("input-first", "first");
      expect(firstInput.receipt.disposition).toBe("started");
      const first = await firstInput.turn;
      const firstMessages = collectMessages(first.events);
      await rs.waitFor(() => expect(prompts).toEqual(["first"]));
      await first.interrupt!("user-stop");
      expect(await firstMessages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );

      const secondInput = submit("input-second", "second");
      expect(secondInput.receipt.disposition).toBe("started");
      const second = await secondInput.turn;
      const secondMessages = collectMessages(second.events);
      await rs.waitFor(() => expect(prompts).toEqual(["first", "second"]));
      await first.interrupt!("late-repeat");
      expect(cancels).toHaveBeenCalledTimes(1);
      releaseSecond();
      expect(await secondMessages).toContainEqual(
        expect.objectContaining({ type: "result", content: "Next turn" }),
      );
      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({
        isNewSession: false,
        providerThreadId: "persisted-claude-thread",
      });
      expect(session.status).toBe("idle");
      await manager.shutdown();
    });

    it("reopens an aborted provider before forking its current checkpoint", async () => {
      const opens: ModelSessionParams[] = [];
      let releaseInterrupted!: () => void;
      const interruptedGate = new Promise<void>((resolve) => {
        releaseInterrupted = resolve;
      });
      let beginInterrupted!: () => void;
      const interruptedBegun = new Promise<void>((resolve) => {
        beginInterrupted = resolve;
      });
      let providerFork: ModelSessionForkParams | undefined;
      const provider: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        async openSession(params) {
          opens.push(params);
          const first = opens.length === 1;
          let disposed = false;
          const model = createSessionFromRun(
            "anthropic",
            async function* () {
              if (!first) return;
              beginInterrupted();
              await interruptedGate;
              yield { type: "result", content: "Work before cancellation" };
              await model.close();
            },
            params,
          );
          return {
            ...model,
            providerThreadId: "persisted-claude-thread",
            get isClosed() {
              return disposed;
            },
            get lastCompletedTurnCheckpoint() {
              return first ? "assistant-current" : undefined;
            },
            async interrupt() {
              if (!first || disposed) return;
              disposed = true;
              releaseInterrupted();
            },
            async fork(forkParams) {
              if (disposed) throw new Error("Cannot fork a closed ModelSession");
              providerFork = forkParams;
              return {
                providerId: "anthropic" as const,
                sessionId: forkParams.sessionId,
                sourceSessionId: params.sessionId,
                sourceProviderThreadId: "persisted-claude-thread",
                mode: forkParams.mode ?? "ephemeral",
                providerThreadId: forkParams.sessionId,
                open: async () =>
                  forkSessionStub({
                    providerId: "anthropic",
                    model: "claude-fork",
                    events: (async function* (): AsyncIterable<AgentMessage> {
                      yield { type: "result", content: "Fork complete" };
                    })(),
                  }),
              };
            },
            async close() {
              disposed = true;
              await model.close();
            },
          };
        },
      };
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
        { keepAliveAcrossTurns: true },
      );
      const runner = new AgentRunner(manager);
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:abort-fork",
      });
      const interrupted = session.sendTurn({ prompt: "first" });
      const interruptedMessages = collectMessages(interrupted.events);
      await interruptedBegun;
      await interrupted.interrupt!("user-stop");
      expect(await interruptedMessages).toContainEqual(
        expect.objectContaining({ type: "turn_end", status: "interrupted" }),
      );

      const forkMessages = await collectMessages(
        runner.runForked({
          agentName: "test-main",
          sourceSessionId: session.sessionId,
          channelThreadKey: "webchat:abort-fork",
          prompt: "fork it",
          mode: "exact",
          sourceCheckpoint: {
            providerId: "anthropic",
            providerThreadId: "persisted-claude-thread",
            checkpointId: "assistant-current",
          },
        }),
      );

      expect(forkMessages.map((message) => message.type)).toEqual([
        "turn_start",
        "result",
        "turn_end",
      ]);
      expect(forkMessages[1]).toMatchObject({ type: "result", content: "Fork complete" });
      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({
        isNewSession: false,
        providerThreadId: "persisted-claude-thread",
      });
      expect(providerFork).toMatchObject({
        configurationMode: "exact",
        sourceCheckpoint: "assistant-current",
      });
      await manager.shutdown();
    });

    it("resumes an explicit sessionId without a caller-provided channelThreadKey", async () => {
      const sendTurn: AgentSession["sendTurn"] = rs.fn(() => ({
        turnId: "turn-1",
        events: (async function* () {
          yield { type: "result", content: "resumed", agent: "test-main" } as const;
        })(),
        turnContext: context.active(),
      }));
      const session: AgentSession = {
        key: { agentName: "test-main", channelThreadKey: "telegram:t-1" },
        sessionId: "sess-1",
        status: "idle",
        sendTurn,
        subscribe: rs.fn(() => () => undefined),
        onStatusChange: rs.fn(() => () => undefined),
        interrupt: rs.fn(async () => undefined),
        close: rs.fn(async () => undefined),
      };
      const manager: AgentSessionManager = {
        acquire: rs.fn(async () => {
          throw new Error("implicit acquire should not be used");
        }),
        acquireBySessionId: rs.fn(async () => session),
        peek: rs.fn(() => undefined),
        shutdown: rs.fn(async () => undefined),
      };
      const runner = new AgentRunner(manager);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue approval",
          sessionId: "sess-1",
        }),
      );

      expect(manager.acquireBySessionId).toHaveBeenCalledWith(
        "sess-1",
        "test-main",
        expect.objectContaining({}),
      );
      expect(manager.acquire).not.toHaveBeenCalled();
      expect(sendTurn).toHaveBeenCalledWith(
        { prompt: "Continue approval" },
        expect.objectContaining({ initiatedBy: "user" }),
      );
    });

    it("creates new session when no existing session found", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Hello" },
          { type: "result", content: "Hello" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hi",
          channelThreadKey: "telegram:thread-new",
        }),
      );

      const sessionInit = messages.find((m) => m.type === "session_init");
      expect(sessionInit).toBeDefined();
      expect(
        (
          sessionInit as {
            type: "session_init";
            sessionId: string;
            systemPrompt?: string;
            userPrompt?: string;
          }
        ).sessionId,
      ).toBeDefined();
    });

    it("reuses an active session for the same key", async () => {
      const repo = new SessionsRepository(testDb.db);
      const existingId = await repo.create({
        agentName: "test-main",
        channelThreadKey: "telegram:thread-reuse",
        status: "active",
      });

      const provider = new MockModelProvider([
        [
          { type: "text", content: "Reused" },
          { type: "result", content: "Reused" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "telegram:thread-reuse",
        }),
      );

      const sessionInit = messages.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };
      expect(sessionInit.sessionId).toBe(existingId);
    });

    it("rotates an expired external-IM provider generation before running the turn", async () => {
      const repo = new SessionsRepository(testDb.db);
      const existingId = await repo.create({
        id: "expired-generation",
        agentName: "test-main",
        channelThreadKey: "telegram:thread-reset",
      });
      await testDb.db
        .update(sessions)
        .set({ lastActiveAt: new Date("2026-07-01T00:00:00Z") })
        .where(eq(sessions.id, existingId));

      const provider = new MockModelProvider([
        [
          { type: "text", content: "Fresh context" },
          { type: "result", content: "Fresh context" },
        ],
      ]);
      const runner = createRunner(provider, undefined, {
        resetPolicy: { mode: "idle", idleMinutes: 10_080 },
      });
      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "telegram:thread-reset",
          romeSessionId: "channel:telegram:thread-reset",
          platformMessageId: "message-reset",
          threadContext: {
            channel: "telegram",
            connectionId: "telegram-1",
            threadId: "thread-reset",
          },
        }),
      );

      const sessionInit = messages.find((message) => message.type === "session_init");
      expect(sessionInit?.type === "session_init" ? sessionInit.sessionId : undefined).not.toBe(
        existingId,
      );
      expect((await repo.findById(existingId))?.status).toBe("completed");
      expect(await repo.findByChannelThreadKey("telegram:thread-reset", "test-main")).toMatchObject(
        {
          id: sessionInit?.type === "session_init" ? sessionInit.sessionId : undefined,
          status: "active",
        },
      );
    });

    it("resumes a keyless run by explicit sessionId", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "First" },
          { type: "result", content: "First" },
        ],
        [
          { type: "text", content: "Second" },
          { type: "result", content: "Second" },
        ],
      ]);
      const runner = createRunner(provider);

      const first = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Start ad-hoc session",
        }),
      );
      const firstSession = first.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };

      const second = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Follow up",
          sessionId: firstSession.sessionId,
        }),
      );
      const secondSession = second.find((m) => m.type === "session_init") as {
        type: "session_init";
        sessionId: string;
      };

      expect(secondSession.sessionId).toBe(firstSession.sessionId);
      expect(provider.calls[1]).toMatchObject({
        prompt: "Follow up",
        sessionId: firstSession.sessionId,
        isNewSession: false,
      });
    });

    it("reopens the exact requested session instead of reusing a different cached session", async () => {
      const repo = new SessionsRepository(testDb.db);
      await repo.create({
        id: "sess-old",
        agentName: "test-main",
        channelThreadKey: "telegram:t-1",
        status: "active",
      });
      const provider = new MockModelProvider();
      const modelResolver = createTestModelResolver({
        providers: [provider],
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const key = { agentName: "test-main", channelThreadKey: "telegram:t-1" };
      const cached = await manager.acquire(key, { forceNewSession: true });

      expect(cached.sessionId).not.toBe("sess-old");
      expect(provider.sessions).toHaveLength(1);

      const resumed = await manager.acquireBySessionId!("sess-old", "test-main");

      expect(resumed.sessionId).toBe("sess-old");
      expect(resumed).not.toBe(cached);
      expect(provider.sessions).toHaveLength(2);
      expect(provider.sessions[1]).toMatchObject({
        sessionId: "sess-old",
        // The row has no stored provider identity, so its native thread is not
        // resumed into whichever provider happens to resolve now.
        isNewSession: true,
      });

      await manager.shutdown();
    });
  });

  describe("message yielding", () => {
    it("yields session_init after turn_start, before any content", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );

      // turn_start opens the stream so consumers reset turn-scoped state
      // before anything of the new turn (including session_init) is visible.
      expect(messages[0].type).toBe("turn_start");
      expect(messages[1]).toMatchObject({
        type: "session_init",
        systemPrompt: expect.stringContaining("You are a test main agent."),
        userPrompt: "Hello",
      });
    });

    it("brackets every turn stream with turn_start and turn_end", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Working" },
          { type: "result", content: "Done" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );

      const starts = messages.filter((m) => m.type === "turn_start");
      const ends = messages.filter((m) => m.type === "turn_end");
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        type: "turn_start",
        turnId: expect.any(String),
        sessionId: expect.any(String),
        userPrompt: "Hello",
      });
      // turn_start is the first event of the stream; turn_end is the last.
      expect(messages[0].type).toBe("turn_start");
      expect(messages[messages.length - 1]).toMatchObject({
        type: "turn_end",
        turnId: (starts[0] as { turnId: string }).turnId,
        status: "completed",
        durationMs: expect.any(Number),
      });
    });

    it("persists the provider checkpoint for a completed Rome turn", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const openSession = provider.openSession.bind(provider);
      provider.openSession = rs.fn(async (params) => ({
        ...(await openSession(params)),
        providerThreadId: "provider-thread",
        lastCompletedTurnCheckpoint: "provider-turn-2",
      }));
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      expect(await sessionManager.getTurnCheckpoint(start.sessionId, start.turnId)).toMatchObject({
        sessionId: start.sessionId,
        turnId: start.turnId,
        provider: "mock",
        providerThreadId: "provider-thread",
        checkpointId: "provider-turn-2",
      });
    });

    it("does not persist a provider checkpoint for an interrupted turn", async () => {
      const provider: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        async openSession(params) {
          const session = createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "text", content: "partial output" };
              yield {
                type: "result",
                content: "partial output",
                accounting: {
                  provider: "anthropic",
                  model: params.model,
                  usage: {
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                  },
                  stopReason: "interrupted",
                },
              };
            },
            params,
          );
          return {
            ...session,
            providerThreadId: "claude-thread",
            lastCompletedTurnCheckpoint: "streamed-but-not-resumable-assistant-uuid",
          };
        },
      };
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      expect(await sessionManager.getTurnCheckpoint(start.sessionId, start.turnId)).toBeNull();
      expect(messages.at(-1)).toMatchObject({ type: "turn_end", status: "interrupted" });
    });

    it("persists the session model pin for a completed Rome turn", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      const row = await new SessionsRepository(testDb.db).findById(start.sessionId);
      expect(row).toMatchObject({
        provider: "mock",
        // The concrete model that actually ran, not the tier name.
        model: MODEL_MAP.large,
      });
    });

    it("keeps the model pin NULL for a session whose turns never succeed", async () => {
      const failingProvider: MockModelProvider = new MockModelProvider();
      failingProvider.run = async function* () {
        throw new Error("Model API failure");
      };
      const runner = createRunner(failingProvider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Fail" }),
      );
      const start = messages.find((message) => message.type === "turn_start");
      expect(start).toBeDefined();
      if (!start || start.type !== "turn_start") return;

      const row = await new SessionsRepository(testDb.db).findById(start.sessionId);
      expect(row).toMatchObject({ provider: null, model: null });
    });

    it("ends a user-stopped turn with turn_end status=interrupted", async () => {
      // What AnthropicProvider yields when the user clicks Stop: the aborted
      // request still terminates with a result block whose accounting carries
      // `stopReason: "interrupted"`. The bracket must surface that as its own
      // status so consumers can tell a graceful stop from a true success.
      const provider = new MockModelProvider([
        [
          { type: "text", content: "partial output" },
          {
            type: "result",
            content: "",
            accounting: {
              provider: "mock",
              model: "mock-model",
              usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
              stopReason: "interrupted",
            },
          },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Hello" }),
      );

      expect(messages[messages.length - 1]).toMatchObject({
        type: "turn_end",
        status: "interrupted",
      });
    });

    it("ends an errored turn with turn_end status=error", async () => {
      const failingProvider: MockModelProvider = new MockModelProvider();
      failingProvider.run = async function* () {
        throw new Error("Model API failure");
      };
      const runner = createRunner(failingProvider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Fail" }),
      );

      expect(messages[messages.length - 1]).toMatchObject({
        type: "turn_end",
        status: "error",
      });
    });

    describe("turn span finalization", () => {
      let harness: SpanHarness;

      beforeEach(() => {
        harness = installTestSpanHarness();
      });

      afterEach(async () => {
        await harness.shutdown();
      });

      it("a turn that fails before reaching the events loop closes its spans with ERROR", async () => {
        // Synthetic-error exits (failTurn) must finalize spans the same way
        // provider terminals do; without it, runOneTurn's safety net closes
        // the agent span as OK on a turn that the consumer saw fail.
        const failingProvider: MockModelProvider = new MockModelProvider();
        failingProvider.run = async function* () {
          throw new Error("Model API failure");
        };
        const runner = createRunner(failingProvider);

        await collectMessages(runner.run({ agentName: "test-main", prompt: "Fail" }));

        const spans = await harness.finishedSpans();
        const agentSpan = spans.find((s) => s.name === "agent:test-main");
        const modelSpan = spans.find((s) => s.name === "model.turn");
        expect(agentSpan?.status.code).toBe(SpanStatusCode.ERROR);
        expect(modelSpan?.status.code).toBe(SpanStatusCode.ERROR);
      });

      it("a completed turn closes its spans with OK", async () => {
        const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
        const runner = createRunner(provider);

        await collectMessages(runner.run({ agentName: "test-main", prompt: "Hello" }));

        const spans = await harness.finishedSpans();
        const agentSpan = spans.find((s) => s.name === "agent:test-main");
        const modelSpan = spans.find((s) => s.name === "model.turn");
        expect(agentSpan?.status.code).toBe(SpanStatusCode.OK);
        expect(modelSpan?.status.code).toBe(SpanStatusCode.OK);
      });
    });

    it("yields text messages from model", async () => {
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Hello there" },
          { type: "result", content: "Hello there" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(runner.run({ agentName: "test-main", prompt: "Hi" }));

      const textMessages = messages.filter((m) => m.type === "text");
      expect(textMessages).toHaveLength(1);
      expect((textMessages[0] as { type: "text"; content: string }).content).toBe("Hello there");
    });

    it("yields tool_use and tool_result messages", async () => {
      // Register a custom action
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: {},
        execute: async () => ({ status: "ok" }),
      });

      const provider = new MockModelProvider([
        [
          {
            type: "tool_use",
            id: "tu-standup-1",
            tool: "demo_action",
            input: { name: "standup" },
          },
          {
            type: "tool_result",
            toolUseId: "tu-standup-1",
            tool: "demo_action",
            output: { success: true },
          },
          { type: "result", content: "Scheduled" },
        ],
      ]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Schedule standup" }),
      );

      const toolUse = messages.filter((m) => m.type === "tool_use");
      expect(toolUse).toHaveLength(1);

      const toolResult = messages.filter((m) => m.type === "tool_result");
      expect(toolResult).toHaveLength(1);
    });

    it("yields result message at end", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Final answer" }]]);
      const runner = createRunner(provider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Question" }),
      );

      const resultMessages = messages.filter((m) => m.type === "result");
      expect(resultMessages).toHaveLength(1);
      expect((resultMessages[0] as { type: "result"; content: string }).content).toBe(
        "Final answer",
      );
    });

    it("yields error message on model failure", async () => {
      const failingProvider: MockModelProvider = new MockModelProvider();
      // Override run to throw
      failingProvider.run = async function* () {
        throw new Error("Model API failure");
      };
      const runner = createRunner(failingProvider);

      const messages = await collectMessages(
        runner.run({ agentName: "test-main", prompt: "Fail" }),
      );

      const errorMessages = messages.filter((m) => m.type === "error");
      expect(errorMessages).toHaveLength(1);
      expect((errorMessages[0] as { type: "error"; error: string }).error).toContain(
        "Model API failure",
      );
    });
  });

  describe("agent lifecycle", () => {
    it("dispatches turn start and finish events with thread context and final output", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider = new MockModelProvider([
        [
          { type: "text", content: "Working" },
          {
            type: "result",
            content: "Final answer",
            accounting: {
              provider: "mock",
              model: "mock-large",
              usage: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 10,
                outputTokens: 3,
              },
            },
          },
        ],
      ]);
      const runner = createRunner(provider, lifecycle);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hello lifecycle",
          channelThreadKey: "webchat:session-1",
          threadContext: {
            channel: "webchat",
            threadId: "session-1",
            threadName: "Lifecycle",
            threadType: "private",
            projectName: "alpha",
            projectPath: "alpha/path",
          },
        }),
      );

      expect(lifecycle.started).toHaveLength(1);
      expect(lifecycle.started[0]).toMatchObject({
        type: "agent-turn-started",
        version: 1,
        turn: {
          sessionId: expect.any(String),
          turnId: expect.any(String),
          agentName: "test-main",
          channelThreadKey: "webchat:session-1",
          threadContext: {
            channel: "webchat",
            threadId: "session-1",
            threadName: "Lifecycle",
            threadType: "private",
            projectName: "alpha",
            projectPath: "alpha/path",
          },
        },
        input: { promptLength: "Hello lifecycle".length },
      });
      expect(lifecycle.started[0].input).not.toHaveProperty("prompt");

      expect(lifecycle.finished).toHaveLength(1);
      expect(lifecycle.finished[0]).toMatchObject({
        type: "agent-turn-finished",
        version: 1,
        turn: {
          sessionId: lifecycle.started[0].turn.sessionId,
          turnId: lifecycle.started[0].turn.turnId,
          agentName: "test-main",
          channelThreadKey: "webchat:session-1",
        },
        status: "completed",
        output: {
          text: "Final answer",
          state: "final",
          terminalKind: "result",
          accounting: expect.objectContaining({ provider: "mock", model: "mock-large" }),
        },
        metrics: {
          toolCallCount: 0,
          skillWritten: false,
        },
      });
      expect(lifecycle.finished[0].timing.startedAt).toBe(lifecycle.started[0].timing.startedAt);
      expect(lifecycle.finished[0].timing.finishedAt).toEqual(expect.any(String));
      expect(lifecycle.finished[0].timing.durationMs).toEqual(expect.any(Number));
    });

    it("uses turn-scoped context when a session is reused", async () => {
      const lifecycle = createLifecycleRecorder();
      const observedContexts: Array<{
        channelUserId?: string;
        sharedRunId?: unknown;
      }> = [];
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Record context",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "read-only",
        },
        inputSchema: {},
        execute: async () => {
          const store = actionExecutionContext.getStore();
          observedContexts.push({
            channelUserId: store?.channelContext?.channelUserId,
            sharedRunId: store?.sharedContext?.run_id,
          });
          return { status: "ok" };
        },
      });

      const runImpl = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentMessage> {
        yield {
          type: "tool_use",
          id: `tu-${params.prompt}`,
          tool: "demo_action",
          input: {},
        };
        await params.executeAction("demo_action", {});
        yield {
          type: "tool_result",
          toolUseId: `tu-${params.prompt}`,
          tool: "demo_action",
          output: { ok: true },
        };
        yield { type: "result", content: `done ${params.prompt}` };
      };
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-reused-context",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImpl),
      };
      const runner = createRunner(provider, lifecycle, { keepAliveAcrossTurns: true });

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "first",
          channelThreadKey: "webchat:reused-context",
          threadContext: {
            channel: "webchat",
            threadId: "reused-context",
            channelUserId: "guardian-one",
          },
          sharedContext: { run_id: "run-one" },
        }),
      );
      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "second",
          channelThreadKey: "webchat:reused-context",
          threadContext: {
            channel: "webchat",
            threadId: "reused-context",
            channelUserId: "guardian-two",
          },
          sharedContext: { run_id: "run-two" },
        }),
      );

      expect(lifecycle.started.map((event) => event.turn.threadContext?.channelUserId)).toEqual([
        "guardian-one",
        "guardian-two",
      ]);
      expect(lifecycle.finished.map((event) => event.turn.threadContext?.channelUserId)).toEqual([
        "guardian-one",
        "guardian-two",
      ]);
      expect(observedContexts).toEqual([
        { channelUserId: "guardian-one", sharedRunId: "run-one" },
        { channelUserId: "guardian-two", sharedRunId: "run-two" },
      ]);
    });

    it("does not dispatch finished lifecycle events for turns that never started", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-closable-session",
        builtinTools: new Set<string>(),
        openSession: async (params) => createClosableModelSession(params),
      };
      const modelResolver = createTestModelResolver({
        providers: [provider],
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver, lifecycle), {
        keepAliveAcrossTurns: true,
      });

      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:closed-before-start",
      });
      const first = session.sendTurn({ prompt: "first" });
      const second = session.sendTurn({ prompt: "second" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(lifecycle.started).toHaveLength(1);
      expect(lifecycle.started[0].turn.turnId).toBe(first.turnId);

      await session.close("user");
      await collectMessages(first.events);
      const secondMessages = await collectMessages(second.events);

      expect(secondMessages).toEqual([
        expect.objectContaining({ type: "turn_start", turnId: second.turnId }),
        expect.objectContaining({ type: "error", error: "AgentSession closed" }),
        expect.objectContaining({ type: "turn_end", turnId: second.turnId, status: "error" }),
      ]);
      expect(lifecycle.started).toHaveLength(1);
      expect(lifecycle.finished).toHaveLength(1);
      expect(lifecycle.finished[0].turn.turnId).toBe(first.turnId);
      await manager.shutdown();
    });

    it("dispatches subagent lifecycle events with a turn-scoped parent ref", async () => {
      const lifecycle = createLifecycleRecorder();
      const nestedCalls: import("./agent-runner.js").ModelRunParams[] = [];
      const runImplNested = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentMessage> {
        nestedCalls.push(params);

        if (nestedCalls.length === 1 || nestedCalls.length === 3) {
          const id = `tu-explore-${nestedCalls.length}`;
          yield {
            type: "tool_use",
            id,
            tool: "test-explore",
            input: { prompt: `Inspect ${nestedCalls.length}` },
          };
          const output = await params.executeSubagent(
            "test-explore",
            { prompt: `Inspect ${nestedCalls.length}` },
            { toolUseId: id },
          );
          yield { type: "tool_result", toolUseId: id, tool: "test-explore", output };
          yield { type: "result", content: `Delegated ${nestedCalls.length}` };
          return;
        }

        yield {
          type: "tool_use",
          id: `tu-edit-${nestedCalls.length}`,
          tool: "Edit",
          input: { file_path: "/tmp/agent-runner-test/skills/review.md" },
        };
        yield { type: "result", content: `Explore complete ${nestedCalls.length}` };
      };
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-lifecycle-nested",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImplNested),
      };
      const runner = createRunner(provider, lifecycle, { keepAliveAcrossTurns: true });

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Delegate one",
          channelThreadKey: "webchat:session-subagents",
          threadContext: {
            channel: "webchat",
            threadId: "session-subagents",
            channelUserId: "guardian-one",
          },
        }),
      );
      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Delegate two",
          channelThreadKey: "webchat:session-subagents",
          threadContext: {
            channel: "webchat",
            threadId: "session-subagents",
            channelUserId: "guardian-two",
          },
        }),
      );

      const rootFinished = lifecycle.finished.filter((e) => e.turn.agentName === "test-main");
      const childFinished = lifecycle.finished.filter((e) => e.turn.agentName === "test-explore");

      expect(nestedCalls[0].systemPrompt).toContain("```mermaid");
      expect(nestedCalls[1].systemPrompt).not.toContain("```mermaid");
      expect(nestedCalls[3].systemPrompt).not.toContain("Mermaid fenced code blocks");
      expect(rootFinished).toHaveLength(2);
      expect(childFinished).toHaveLength(2);
      expect(childFinished[0].turn.parent).toEqual({
        sessionId: rootFinished[0].turn.sessionId,
        turnId: rootFinished[0].turn.turnId,
        agentName: "test-main",
      });
      expect(childFinished[1].turn.parent).toEqual({
        sessionId: rootFinished[1].turn.sessionId,
        turnId: rootFinished[1].turn.turnId,
        agentName: "test-main",
      });
      expect(childFinished[0].turn.parent?.turnId).not.toBe(childFinished[1].turn.parent?.turnId);
      expect(childFinished.map((e) => e.turn.threadContext?.channelUserId)).toEqual([
        "guardian-one",
        "guardian-two",
      ]);
      expect(rootFinished[0].metrics).toEqual({ toolCallCount: 1, skillWritten: false });
      expect(rootFinished[1].metrics).toEqual({ toolCallCount: 1, skillWritten: false });
      expect(childFinished[0].metrics).toEqual({ toolCallCount: 1, skillWritten: true });
      expect(childFinished[1].metrics).toEqual({ toolCallCount: 1, skillWritten: true });
    });

    it("classifies provider-interrupted terminal results separately from completions", async () => {
      const lifecycle = createLifecycleRecorder();
      const provider = new MockModelProvider([
        [
          {
            type: "result",
            content: "Partial answer",
            accounting: {
              provider: "mock",
              model: "mock-large",
              usage: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 4,
                outputTokens: 2,
              },
              stopReason: "interrupted",
            },
          },
        ],
      ]);
      const runner = createRunner(provider, lifecycle);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Stop soon" }));

      expect(lifecycle.finished).toHaveLength(1);
      expect(lifecycle.finished[0]).toMatchObject({
        status: "interrupted",
        output: {
          text: "Partial answer",
          state: "partial",
          terminalKind: "result",
          stopReason: "interrupted",
        },
      });
    });
  });

  describe("shared context propagation", () => {
    it("passes sharedContext into action executions triggered by the agent", async () => {
      let observedSharedContext: Record<string, unknown> | undefined;
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: {},
        execute: async () => {
          observedSharedContext = actionExecutionContext.getStore()?.sharedContext;
          return { status: "ok", data: "ok" };
        },
      });

      const runImpl = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentMessage> {
        yield {
          type: "tool_use",
          id: "tu-shared-1",
          tool: "demo_action",
          input: { name: "standup" },
        };
        await params.executeAction("demo_action", { name: "standup" });
        yield {
          type: "tool_result",
          toolUseId: "tu-shared-1",
          tool: "demo_action",
          output: { success: true },
        };
        yield { type: "result", content: "Scheduled" };
      };
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-shared-context",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImpl),
      };
      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Schedule standup",
          sharedContext: {
            company_id: "company-1",
            run_id: "run-1",
          },
        }),
      );

      expect(observedSharedContext).toEqual({
        company_id: "company-1",
        run_id: "run-1",
      });
    });
  });

  describe("prompt building", () => {
    it("calls promptBuilder.build() with correct config and contextSuffix", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Build prompt",
          contextSuffix: "Extra context",
        }),
      );

      expect(provider.calls).toHaveLength(1);
      const call = provider.calls[0];
      expect(call.systemPrompt).toContain("You are a test main agent.");
      expect(call.systemPrompt).toContain("Extra context");
      expect(provider.sessions[0]).toMatchObject({
        agentName: "test-main",
      });
      expect(provider.sessions[0].appStoreListingId).toBeUndefined();
    });

    it("attributes app-store agents by listing id and omits local app attribution", async () => {
      const getRecord = agentLoader.getRecord.bind(agentLoader);
      const recordSpy = rs.spyOn(agentLoader, "getRecord").mockImplementation((name) => {
        const record = getRecord(name);
        if (name !== "test-main") return record;
        return {
          ...record,
          metadata: {
            ...record.metadata,
            ownerType: "app",
            ownerId: "test-app",
          },
        };
      });

      try {
        const provider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
        const appCatalog = {
          get: rs.fn((appId: string) =>
            appId === "test-app"
              ? {
                  source: {
                    mode: "appstore",
                    listingId: "@publisher/test-app",
                    version: "1.0.0",
                  },
                }
              : null,
          ),
        } as unknown as Pick<AppCatalog, "get">;
        const runner = createRunner(provider, undefined, { appCatalog });

        await collectMessages(
          runner.run({
            agentName: "test-main",
            prompt: "Build prompt",
            contextSuffix: "App-supplied session context.",
            channelThreadKey: "webchat:app-prompt",
          }),
        );

        expect(provider.calls[0].systemPrompt).toBe(
          "You are a test main agent. Handle messages and delegate as needed.\n\n" +
            "App-supplied session context.",
        );
        expect(provider.sessions[0]).toMatchObject({
          agentName: "test-main",
          appStoreListingId: "@publisher/test-app",
        });

        const localProvider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
        const localAppCatalog = {
          get: rs.fn(() => ({
            source: {
              mode: "bundle",
              path: "/tmp/test-app",
            },
          })),
        } as unknown as Pick<AppCatalog, "get">;
        const localRunner = createRunner(localProvider, undefined, {
          appCatalog: localAppCatalog,
        });

        await collectMessages(
          localRunner.run({
            agentName: "test-main",
            prompt: "Build local prompt",
            channelThreadKey: "webchat:local-app-prompt",
          }),
        );

        expect(localProvider.sessions[0].appStoreListingId).toBeUndefined();
      } finally {
        recordSpy.mockRestore();
      }
    });

    it("adds Mermaid guidance only for webchat interactive surfaces", async () => {
      const webchatProvider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const webchatRunner = createRunner(webchatProvider);
      await collectMessages(
        webchatRunner.run({
          agentName: "test-main",
          prompt: "Build prompt",
          channelThreadKey: "webchat:prompt-surface",
        }),
      );

      const telegramProvider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const telegramRunner = createRunner(telegramProvider);
      await collectMessages(
        telegramRunner.run({
          agentName: "test-main",
          prompt: "Build prompt",
          channelThreadKey: "telegram:prompt-surface",
        }),
      );

      expect(webchatProvider.calls[0].systemPrompt).toContain("```mermaid");
      expect(webchatProvider.calls[0].systemPrompt).toContain("interactive SVG diagrams");
      expect(telegramProvider.calls[0].systemPrompt).not.toContain("```mermaid");
      expect(telegramProvider.calls[0].systemPrompt).not.toContain("Mermaid fenced code blocks");
    });

    it("defaults the model provider working directory to the default project folder", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Built" }]]);
      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Build prompt",
        }),
      );

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].workingDir).toBe("/tmp/default-project");
    });
  });

  describe("thread-context first-user-prompt block", () => {
    const webchatThreadContext = {
      channel: "webchat",
      threadId: "tc-session-1",
      channelUserId: "guardian",
      threadType: "private" as const,
      projectName: "alpha",
    };
    const projectWorkingDir = "/tmp/agent-runner-test/projects/alpha";

    /** Provider that yields a single result per turn, for any number of turns. */
    function alwaysResultProvider(): ModelProvider {
      return {
        id: "mock",
        displayName: "mock-thread-context",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* () {
          yield { type: "result", content: "ok" };
        }),
      };
    }

    function initUserPrompt(messages: AgentMessage[]): string {
      const init = messages.find((m) => m.type === "session_init") as {
        type: "session_init";
        userPrompt?: string;
      };
      return init?.userPrompt ?? "";
    }

    it("prepends <thread_context> to the first user turn of a fresh session", async () => {
      const runner = createRunner(alwaysResultProvider());

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Hello",
          channelThreadKey: "webchat:tc-fresh",
          threadContext: webchatThreadContext,
          workingDir: projectWorkingDir,
        }),
      );

      const userPrompt = initUserPrompt(messages);
      expect(userPrompt).toContain("<thread_context>");
      expect(userPrompt).toMatch(/<\/thread_context>/);
      expect(userPrompt).toContain("channel: webchat");
      expect(userPrompt).toContain("thread id: tc-session-1");
      expect(userPrompt).toContain("channelUserId: guardian");
      expect(userPrompt).toContain("is direct message: yes");
      expect(userPrompt).toContain(`Current selected project is "alpha" at ${projectWorkingDir}`);
      // The block precedes the user's own text.
      expect(userPrompt.indexOf("<thread_context>")).toBeLessThan(userPrompt.indexOf("Hello"));
    });

    it("does not repeat the block on later turns of the same session", async () => {
      const modelResolver = createTestModelResolver({
        providers: [alwaysResultProvider()],
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire(
        { agentName: "test-main", channelThreadKey: "webchat:tc-kept-alive" },
        { threadContext: webchatThreadContext, workingDir: projectWorkingDir },
      );

      const first = await collectMessages(
        session.sendTurn({ prompt: "First" }, { threadContext: webchatThreadContext }).events,
      );
      const second = await collectMessages(
        session.sendTurn({ prompt: "Second" }, { threadContext: webchatThreadContext }).events,
      );

      expect(initUserPrompt(first)).toContain("<thread_context>");
      expect(initUserPrompt(second)).not.toContain("<thread_context>");
      await manager.shutdown();
    });

    it("does not inject into a resumed session (the block is already in its history)", async () => {
      // Pre-create the DB session so findReusableSession resolves it → isNewSession=false.
      const repo = new SessionsRepository(testDb.db);
      await repo.create({
        agentName: "test-main",
        channelThreadKey: "webchat:tc-resumed",
        status: "active",
      });
      const runner = createRunner(alwaysResultProvider());

      const messages = await collectMessages(
        runner.run({
          agentName: "test-main",
          prompt: "Continue",
          channelThreadKey: "webchat:tc-resumed",
          threadContext: webchatThreadContext,
          workingDir: projectWorkingDir,
        }),
      );

      expect(initUserPrompt(messages)).not.toContain("<thread_context>");
    });

    it("does not inject into subagent sessions", async () => {
      const modelResolver = createTestModelResolver({
        providers: [alwaysResultProvider()],
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        isSubagent: true,
      });
      const session = await manager.acquire(
        { agentName: "test-main", channelThreadKey: "webchat:tc-subagent" },
        { threadContext: webchatThreadContext, workingDir: projectWorkingDir },
      );

      const messages = await collectMessages(
        session.sendTurn({ prompt: "Subtask" }, { threadContext: webchatThreadContext }).events,
      );

      expect(initUserPrompt(messages)).not.toContain("<thread_context>");
      await manager.shutdown();
    });

    it("injects pending channel notifications and exact reply context once before the current message", async () => {
      const webchatRepo = new WebChatRepository(testDb.db);
      const conversation = await webchatRepo.ensureChannelConversation({
        channel: "discord",
        threadId: "channel-context",
        agentName: "main",
      });
      const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);
      await webchatRepo.addConversationMessage({
        sessionId: conversation.id,
        role: "user",
        content: textContent("original message"),
        platformMessageId: "original-message",
        senderName: "Alice",
        createdAt: new Date("2026-08-03T08:00:00.000Z"),
      });
      await webchatRepo.addConversationMessage({
        sessionId: conversation.id,
        role: "notification",
        content: textContent("ambient update"),
        platformMessageId: "ambient-message",
        senderName: "Bob",
        createdAt: new Date("2026-08-03T08:01:00.000Z"),
      });

      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-conversation-context",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };
      await collectMessages(
        createRunner(provider).run({
          agentName: "test-main",
          prompt: "current message",
          channelThreadKey: "discord:channel-context",
          romeSessionId: conversation.id,
          platformMessageId: "current-message",
          replyTo: {
            messageId: "original-message",
            content: "stale provider snapshot",
            senderName: "Wrong sender",
          },
          threadContext: {
            channel: "discord",
            threadId: "channel-context",
            channelUserId: "guardian",
            threadType: "group",
          },
        }),
      );

      expect(providerPrompts).toHaveLength(1);
      const prompt = providerPrompts[0] ?? "";
      expect(prompt).toContain("<conversation_context>");
      expect(prompt).toContain("Bob: ambient update");
      expect(prompt).toContain("<reply_context>");
      expect(prompt).toContain("Alice: original message");
      expect(prompt).not.toContain("stale provider snapshot");
      expect(prompt).toContain("<current_message>\ncurrent message\n</current_message>");
      expect(prompt.indexOf("<conversation_context>")).toBeLessThan(
        prompt.indexOf("<reply_context>"),
      );
      expect(prompt.indexOf("<reply_context>")).toBeLessThan(prompt.indexOf("<current_message>"));

      await expect(webchatRepo.loadConversationContext(conversation.id)).resolves.toEqual({
        notifications: [],
        pendingNotificationIds: [],
        omittedNotificationCount: 0,
        repliedTo: null,
      });
    });

    it("injects a child thread's parent starter before Rome's first reply and the current message", async () => {
      const webchatRepo = new WebChatRepository(testDb.db);
      const parent = await webchatRepo.ensureChannelConversation({
        channel: "discord",
        threadId: "parent-channel-thread-starter",
        agentName: "main",
      });
      const child = await webchatRepo.ensureChannelConversation({
        channel: "discord",
        threadId: "child-thread-starter-context",
        parentThreadId: "parent-channel-thread-starter",
        agentName: "main",
      });
      const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);
      await webchatRepo.addConversationMessage({
        sessionId: parent.id,
        role: "user",
        content: textContent("Should we ship on Friday?"),
        platformMessageId: "thread-starter-message",
        senderName: "Alice",
      });
      await webchatRepo.recordOutboundConversationMessage({
        sessionId: child.id,
        content: textContent("We should check the release checklist first."),
        platformMessageId: "rome-first-thread-reply",
        senderId: "rome",
        senderName: "Rome",
        replyToPlatformMessageId: "thread-starter-message",
        knownToProvider: false,
      });

      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-child-thread-context",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };
      await collectMessages(
        createRunner(provider).run({
          agentName: "test-main",
          prompt: "What deadline did you mean?",
          channelThreadKey: "discord:child-thread-starter-context",
          romeSessionId: child.id,
          platformMessageId: "child-current-message",
          threadContext: {
            channel: "discord",
            threadId: "child-thread-starter-context",
            parentThreadId: "parent-channel-thread-starter",
            channelUserId: "guardian",
            threadType: "group",
          },
        }),
      );

      expect(providerPrompts).toHaveLength(1);
      const prompt = providerPrompts[0] ?? "";
      expect(prompt).toContain("Alice: Should we ship on Friday?");
      expect(prompt).toContain("Rome: We should check the release checklist first.");
      expect(prompt).toContain(
        "<current_message>\nWhat deadline did you mean?\n</current_message>",
      );
      expect(prompt.indexOf("Alice: Should we ship on Friday?")).toBeLessThan(
        prompt.indexOf("Rome: We should check the release checklist first."),
      );
      expect(prompt.indexOf("Rome: We should check the release checklist first.")).toBeLessThan(
        prompt.indexOf("<current_message>"),
      );
      await expect(webchatRepo.loadConversationContext(child.id)).resolves.toEqual({
        notifications: [],
        pendingNotificationIds: [],
        omittedNotificationCount: 0,
        repliedTo: null,
      });
    });

    it("injects only the latest 20 pending notifications and marks the omitted snapshot consumed", async () => {
      const webchatRepo = new WebChatRepository(testDb.db);
      const conversation = await webchatRepo.ensureChannelConversation({
        channel: "discord",
        threadId: "bounded-channel-context",
        agentName: "main",
      });
      const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);
      for (let index = 0; index < 21; index += 1) {
        await webchatRepo.addConversationMessage({
          sessionId: conversation.id,
          role: "notification",
          content: textContent(`ambient ${index + 1}`),
          platformMessageId: `ambient-${index + 1}`,
          senderName: "Participant",
          createdAt: new Date(Date.UTC(2026, 7, 3, 8, index)),
        });
      }

      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-bounded-conversation-context",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };
      await collectMessages(
        createRunner(provider).run({
          agentName: "test-main",
          prompt: "current message",
          channelThreadKey: "discord:bounded-channel-context",
          romeSessionId: conversation.id,
          platformMessageId: "current-message",
          threadContext: {
            channel: "discord",
            threadId: "bounded-channel-context",
            channelUserId: "guardian",
            threadType: "group",
          },
        }),
      );

      const prompt = providerPrompts[0] ?? "";
      expect(prompt).toContain("[1 earlier messages omitted]");
      expect(prompt).not.toContain("Participant: ambient 1\n");
      expect(prompt).toContain("Participant: ambient 2");
      expect(prompt).toContain("Participant: ambient 21");
      await expect(webchatRepo.loadConversationContext(conversation.id)).resolves.toEqual({
        notifications: [],
        pendingNotificationIds: [],
        omittedNotificationCount: 0,
        repliedTo: null,
      });
    });

    it("uses provider-supplied reply content for the current turn without persisting a synthetic message", async () => {
      const webchatRepo = new WebChatRepository(testDb.db);
      const conversation = await webchatRepo.ensureChannelConversation({
        channel: "wechat",
        threadId: "wechat-runtime-reply",
        agentName: "main",
      });
      const providerPrompts: string[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-runtime-reply",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", async function* (input) {
          providerPrompts.push(input.prompt);
          yield { type: "result", content: "ok" };
        }),
      };

      await collectMessages(
        createRunner(provider).run({
          agentName: "test-main",
          prompt: "What does the first word mean?",
          channelThreadKey: "wechat:wechat-runtime-reply",
          romeSessionId: conversation.id,
          platformMessageId: "current-message",
          replyTo: {
            messageId: "wechat-server-42",
            content: "Jack Ma profile",
            senderName: "Rome",
          },
          threadContext: {
            channel: "wechat",
            threadId: "wechat-runtime-reply",
            channelUserId: "guardian",
            threadType: "private",
          },
        }),
      );

      expect(providerPrompts[0]).toContain(
        "<reply_context>\nRome: Jack Ma profile\n</reply_context>",
      );
      await expect(
        webchatRepo.loadConversationContext(conversation.id, "wechat-server-42"),
      ).resolves.toEqual({
        notifications: [],
        pendingNotificationIds: [],
        omittedNotificationCount: 0,
        repliedTo: null,
      });
    });
  });

  describe("model mapping", () => {
    it("uses the agent reasoning effort and defaults missing YAML values to high", async () => {
      const configuredProvider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      await collectMessages(
        createRunner(configuredProvider).run({
          agentName: "test-all-actions",
          prompt: "Use configured effort",
        }),
      );
      expect(configuredProvider.sessions[0].reasoningEffort).toBe("low");

      const defaultProvider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      await collectMessages(
        createRunner(defaultProvider).run({
          agentName: "test-main",
          prompt: "Use default effort",
        }),
      );
      expect(defaultProvider.sessions[0].reasoningEffort).toBe("high");
    });

    it("maps tier names correctly (large, medium, small)", async () => {
      // test-main maps to "large" tier
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Map model" }));

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].model).toBe(MODEL_MAP.large);

      // test-sentinel maps to "small" tier
      const provider2 = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner2 = createRunner(provider2);

      await collectMessages(runner2.run({ agentName: "test-sentinel", prompt: "Map model" }));

      expect(provider2.calls[0].model).toBe(MODEL_MAP.small);
    });

    it("pins the session to the agent's configured provider and fails closed", async () => {
      // test-pinned declares `provider: openai` (tier small). The pin must
      // reach session resolution: with Codex usable the session opens on the
      // Codex small model, and with Codex logged out the session must fail
      // instead of silently falling back to Claude — an unpinned agent would
      // have fallen back, so the rejection is what proves the threading.
      const anthropicSessions: ModelSessionParams[] = [];
      const openAiSessions: ModelSessionParams[] = [];
      const anthropic: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          anthropicSessions.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: "anthropic" };
            },
            params,
          );
        },
      };
      const openai: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          openAiSessions.push(params);
          return createSessionFromRun(
            "openai",
            async function* () {
              yield { type: "result", content: "openai" };
            },
            params,
          );
        },
      };

      const modelResolver = createTestModelResolver({ providers: [anthropic, openai] });
      const manager = createAgentSessionManager(managerDeps(modelResolver));
      const session = await manager.acquire(
        { agentName: "test-pinned", channelThreadKey: "webchat:pinned-1" },
        {},
      );
      await collectMessages(session.sendTurn({ prompt: "Map model" }).events);

      expect(anthropicSessions).toHaveLength(0);
      expect(openAiSessions).toHaveLength(1);
      expect(openAiSessions[0].model).toBe("gpt-5.6-luna");
      await manager.shutdown();

      const codexLoggedOut = {
        codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      const loggedOutResolver = createModelResolver({
        providers: [anthropic, openai],
        aiToolState: { get: () => codexLoggedOut, refresh: async () => codexLoggedOut },
      });
      const loggedOutManager = createAgentSessionManager(managerDeps(loggedOutResolver));

      await expect(
        loggedOutManager.acquire(
          { agentName: "test-pinned", channelThreadKey: "webchat:pinned-2" },
          {},
        ),
      ).rejects.toMatchObject({
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "not_logged_in",
      });
      expect(anthropicSessions).toHaveLength(0);
      await loggedOutManager.shutdown();
    });

    it("honors an exact per-session model selection", async () => {
      const anthropicSessions: ModelSessionParams[] = [];
      const openAiSessions: ModelSessionParams[] = [];
      const anthropic: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          anthropicSessions.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: "anthropic" };
            },
            params,
          );
        },
      };
      const openai: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          openAiSessions.push(params);
          return createSessionFromRun(
            "openai",
            async function* () {
              yield { type: "result", content: "openai" };
            },
            params,
          );
        },
      };
      const modelResolver = createTestModelResolver({
        providers: [anthropic, openai],
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver));

      const session = await manager.acquire(
        {
          agentName: "test-main",
          channelThreadKey: "webchat:session-1:large-model:gpt-5-6-terra",
        },
        { selectionId: "gpt-5-6-terra" },
      );
      const handle = session.sendTurn({ prompt: "Map model" });
      await collectMessages(handle.events);

      expect(anthropicSessions).toHaveLength(0);
      expect(openAiSessions).toHaveLength(1);
      expect(openAiSessions[0].model).toBe("gpt-5.6-terra");
    });

    it("restores the selected model from the persisted session key on explicit cold resume", async () => {
      const openAiSessions: ModelSessionParams[] = [];
      const openai: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          openAiSessions.push(params);
          const modelSession = createSessionFromRun(
            "openai",
            async function* () {
              yield { type: "result", content: "openai" };
            },
            params,
          );
          modelSession.providerThreadId = "codex-thread-1";
          return modelSession;
        },
      };
      const modelResolver = createTestModelResolver({ providers: [openai] });
      const firstManager = createAgentSessionManager(managerDeps(modelResolver));
      const key = {
        agentName: "test-main",
        channelThreadKey: "webchat:session-cold:large-model:gpt-5-6-terra",
      };
      const firstSession = await firstManager.acquire(key, { selectionId: "gpt-5-6-terra" });
      await collectMessages(firstSession.sendTurn({ prompt: "Start" }).events);
      await firstManager.shutdown();

      const resumedManager = createAgentSessionManager(managerDeps(modelResolver));
      const resumedRunner = new AgentRunner(resumedManager);
      const resumedMessages = await collectMessages(
        resumedRunner.run({
          agentName: "test-main",
          sessionId: firstSession.sessionId,
          prompt: "Continue",
        }),
      );

      expect(openAiSessions).toHaveLength(2);
      expect(openAiSessions[0]).toMatchObject({
        model: "gpt-5.6-terra",
        isNewSession: true,
      });
      expect(openAiSessions[1]).toMatchObject({
        model: "gpt-5.6-terra",
        isNewSession: false,
        providerThreadId: "codex-thread-1",
      });
      expect(resumedMessages.find((message) => message.type === "session_init")).toMatchObject({
        sessionId: firstSession.sessionId,
      });
      await resumedManager.shutdown();
    });
  });

  describe("per-turn model resolution", () => {
    it("does not replay a failed turn and selects the other provider on the next turn", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      let codexTurns = 0;
      let claudeTurns = 0;
      const claudeOpens: ModelSessionParams[] = [];
      const codex: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set(),
        openSession: async (params) => {
          const session = createSessionFromRun(
            "openai",
            async function* () {
              codexTurns += 1;
              state.codex.quotaExhausted = true;
              yield { type: "error", error: "Codex quota exhausted", code: "usage_limit" };
            },
            params,
          );
          session.providerThreadId = "codex-thread";
          return session;
        },
      };
      const claude: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        openSession: async (params) => {
          claudeOpens.push(params);
          const session = createSessionFromRun(
            "anthropic",
            async function* () {
              claudeTurns += 1;
              yield { type: "result", content: "Claude handled the next turn" };
            },
            params,
          );
          session.providerThreadId = "claude-thread";
          return session;
        },
      };
      const modelResolver = createModelResolver({
        providers: [codex, claude],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:per-turn-fallback",
      });

      const first = await collectMessages(session.sendTurn({ prompt: "first" }).events);
      expect(first.find((message) => message.type === "error")).toMatchObject({
        error: "Codex quota exhausted",
      });
      expect(codexTurns).toBe(1);
      expect(claudeTurns).toBe(0);

      const second = await collectMessages(session.sendTurn({ prompt: "second" }).events);
      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: "Claude handled the next turn",
      });
      expect(codexTurns).toBe(1);
      expect(claudeTurns).toBe(1);
      expect(claudeOpens[0]).toMatchObject({ isNewSession: true });
      expect(claudeOpens[0].providerThreadId).toBeUndefined();
      await manager.shutdown();
    });

    it("reopens a provider backend after an auth-revoked terminal", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const codex: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          const openNumber = opens.length;
          const session = createSessionFromRun(
            "openai",
            async function* () {
              if (openNumber === 1) {
                state.codex.loggedIn = false;
                yield {
                  type: "error",
                  error: "Codex credentials were revoked",
                  code: "auth_revoked",
                };
                return;
              }
              yield { type: "result", content: "Codex reconnected" };
            },
            params,
          );
          session.providerThreadId = "codex-thread";
          return session;
        },
      };
      const modelResolver = createModelResolver({
        providers: [codex],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:auth-revoked-reopen",
      });

      const first = await collectMessages(session.sendTurn({ prompt: "first" }).events);
      expect(first.find((message) => message.type === "error")).toMatchObject({
        code: "auth_revoked",
        provider: "openai",
      });

      // Simulate a completed re-login. The next turn must not reuse the model
      // session that observed the revoked credential.
      state.codex.loggedIn = true;
      const second = await collectMessages(session.sendTurn({ prompt: "second" }).events);

      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: "Codex reconnected",
      });
      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({
        isNewSession: false,
        providerThreadId: "codex-thread",
      });
      await manager.shutdown();
    });

    it("reopens the same provider when an unpinned session's resolved model changes and keeps its native thread", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const codex: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          const openNumber = opens.length;
          const session = createSessionFromRun(
            "openai",
            async function* () {
              if (openNumber === 1) {
                // Fail the first turn so the session never records a pin —
                // per-turn tier re-resolution stays in effect (it survives for
                // unpinned sessions only).
                yield { type: "error", error: "Model API failure" };
                return;
              }
              yield { type: "result", content: params.model };
            },
            params,
          );
          session.providerThreadId = "codex-thread";
          return session;
        },
      };
      const modelResolver = createModelResolver({
        providers: [codex],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:per-turn-model",
      });
      await collectMessages(session.sendTurn({ prompt: "Sol" }).events);

      state.codex.solAccess = false;
      await collectMessages(session.sendTurn({ prompt: "Terra" }).events);

      expect(opens.map((params) => params.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
      expect(opens[1]).toMatchObject({
        isNewSession: false,
        providerThreadId: "codex-thread",
      });
      await manager.shutdown();
    });

    it("records the pin of the model that actually ran after an unpinned backend swap", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      const codex: ModelProvider = {
        id: "openai",
        displayName: "Codex",
        builtinTools: new Set(),
        openSession: async (params) =>
          createSessionFromRun(
            "openai",
            async function* () {
              // Codex turns never succeed, so the session stays unpinned.
              yield { type: "error", error: "Codex is down" };
            },
            params,
          ),
      };
      const claude: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        openSession: async (params) =>
          createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: params.model };
            },
            params,
          ),
      };
      const modelResolver = createModelResolver({
        providers: [codex, claude],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:model-pin-swap",
      });
      const repo = new SessionsRepository(testDb.db);

      // First turn fails on Codex → no pin recorded.
      await collectMessages(session.sendTurn({ prompt: "Sol" }).events);
      expect((await repo.findById(session.sessionId))!.model).toBeNull();

      // Codex quota exhausts; the unpinned session re-resolves to Claude and
      // the first successful turn pins the model that actually ran.
      state.codex.quotaExhausted = true;
      await collectMessages(session.sendTurn({ prompt: "Terra" }).events);
      expect(await repo.findById(session.sessionId)).toMatchObject({
        provider: "anthropic",
        model: MODEL_MAP.large,
      });

      await manager.shutdown();
    });
  });

  describe("session model pin resolution", () => {
    const FABLE_MODEL = "claude-fable-5[1m]";

    // Records every open and echoes the resolved model back as the turn result,
    // so a test can assert which concrete model actually ran.
    function recordingProvider(
      id: ProviderId,
      displayName: string,
      providerThreadId: string,
      opens: ModelSessionParams[],
    ): ModelProvider {
      return {
        id,
        displayName,
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          const session = createSessionFromRun(
            id,
            async function* () {
              yield { type: "result", content: params.model };
            },
            params,
          );
          session.providerThreadId = providerThreadId;
          return session;
        },
      };
    }

    const codexProvider = (opens: ModelSessionParams[]): ModelProvider =>
      recordingProvider("openai", "Codex", "codex-thread", opens);

    const claudeProvider = (opens: ModelSessionParams[]): ModelProvider =>
      recordingProvider("anthropic", "Claude", "claude-thread", opens);

    it("a pinned session keeps its model across an entitlement upgrade (no backend reopen)", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: false, lunaAccess: false },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:pin-sticks",
      });

      await collectMessages(session.sendTurn({ prompt: "first" }).events);
      expect((await new SessionsRepository(testDb.db).findById(session.sessionId))!.model).toBe(
        "gpt-5.6-terra",
      );

      // Sol access arrives mid-session. Tier resolution would now map large →
      // Sol, but the pinned session must keep running Terra on the same
      // backend — no close/reopen, no model switch.
      state.codex.solAccess = true;
      const second = await collectMessages(session.sendTurn({ prompt: "second" }).events);

      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: "gpt-5.6-terra",
      });
      expect(opens).toHaveLength(1);
      await manager.shutdown();
    });

    it("a Fable-pinned session keeps running Fable after the setting is turned off", async () => {
      const state = {
        codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      let enableFable = true;
      const opens: ModelSessionParams[] = [];
      const claude: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        openSession: async (params) => {
          opens.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: params.model };
            },
            params,
          );
        },
      };
      const modelResolver = createModelResolver({
        providers: [claude],
        aiToolState: { get: () => state, refresh: async () => state },
        settingsRepo: {
          get: async <T = unknown>(key: string): Promise<T | null> =>
            key === "enableFable" ? (enableFable as T) : null,
        },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:fable-pin",
      });

      await collectMessages(session.sendTurn({ prompt: "first" }).events);
      expect(opens[0].model).toBe(FABLE_MODEL);

      // The toggle is a Rome-side preference, not an entitlement: it governs
      // new resolutions only. The pinned session stays on Fable.
      enableFable = false;
      const second = await collectMessages(session.sendTurn({ prompt: "second" }).events);

      expect(second.find((message) => message.type === "result")).toMatchObject({
        content: FABLE_MODEL,
      });
      expect(opens).toHaveLength(1);
      await manager.shutdown();
    });

    it("a stranded pinned session fails the turn with the structured resolution error", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const claude: ModelProvider = {
        id: "anthropic",
        displayName: "Claude",
        builtinTools: new Set(),
        openSession: async (params) => {
          claudeOpens.push(params);
          return createSessionFromRun(
            "anthropic",
            async function* () {
              yield { type: "result", content: params.model };
            },
            params,
          );
        },
      };
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens), claude],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const manager = createAgentSessionManager(managerDeps(modelResolver), {
        keepAliveAcrossTurns: true,
      });
      const session = await manager.acquire({
        agentName: "test-main",
        channelThreadKey: "webchat:pin-stranded",
      });

      await collectMessages(session.sendTurn({ prompt: "first" }).events);
      expect(opens.map((params) => params.model)).toEqual(["gpt-5.6-sol"]);

      // Sol access is lost. The pinned session must fail closed with the
      // structured error — no tier re-map to Terra, no Claude substitution.
      state.codex.solAccess = false;
      const second = await collectMessages(session.sendTurn({ prompt: "second" }).events);
      expect(second.find((message) => message.type === "error")).toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });

      // Provider-level outage (quota) fails the same way.
      state.codex.solAccess = true;
      state.codex.quotaExhausted = true;
      const third = await collectMessages(session.sendTurn({ prompt: "third" }).events);
      expect(third.find((message) => message.type === "error")).toMatchObject({
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "quota_exhausted",
      });

      expect(opens).toHaveLength(1);
      expect(claudeOpens).toHaveLength(0);
      await manager.shutdown();
    });

    it("a legacy session (NULL pin) resolves by tier, then pins on its next successful turn", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const repo = new SessionsRepository(testDb.db);
      const legacyId = await repo.create({
        agentName: "test-main",
        channelThreadKey: "telegram:legacy-row",
        status: "active",
      });
      // A pre-cutover row: provider + thread persisted, model NULL.
      await repo.setProviderInfo(legacyId, "openai", "codex-thread");

      const manager = createAgentSessionManager(managerDeps(modelResolver));
      const runner = new AgentRunner(manager);
      await collectMessages(
        runner.run({ agentName: "test-main", sessionId: legacyId, prompt: "Continue" }),
      );

      // Tier resolution as before the pin (large → Sol with access), carrying
      // the stored provider thread; the successful turn then records the pin.
      expect(opens).toHaveLength(1);
      expect(opens[0]).toMatchObject({
        model: "gpt-5.6-sol",
        isNewSession: false,
        providerThreadId: "codex-thread",
      });
      expect(await repo.findById(legacyId)).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-sol",
      });
      await manager.shutdown();
    });

    it("a new session of another agent on the same thread resolves its own tier (no pin inheritance)", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: false },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const repo = new SessionsRepository(testDb.db);
      // The main agent's session on this thread is pinned to Sol.
      const mainId = await repo.create({
        agentName: "test-main",
        channelThreadKey: "webchat:shared-thread",
        status: "active",
      });
      await repo.setProviderInfo(mainId, "openai", "codex-thread", "gpt-5.6-sol");

      // A subagent reuses the parent's channelThreadKey; session lookup is
      // agent-scoped, so its fresh session resolves from its own tier (small
      // → Terra without Luna access) instead of inheriting the parent's pin.
      const manager = createAgentSessionManager(managerDeps(modelResolver));
      const session = await manager.acquire({
        agentName: "test-explore",
        channelThreadKey: "webchat:shared-thread",
      });
      await collectMessages(session.sendTurn({ prompt: "explore" }).events);

      expect(session.sessionId).not.toBe(mainId);
      expect(opens).toHaveLength(1);
      expect(opens[0]).toMatchObject({ model: "gpt-5.6-terra", isNewSession: true });
      expect(opens[0].providerThreadId).toBeUndefined();
      await manager.shutdown();
    });

    it("a resumed session runs on its pin even when tier resolution would pick another model", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: false, lunaAccess: false },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const opens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(opens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });
      const firstManager = createAgentSessionManager(managerDeps(modelResolver));
      const first = await firstManager.acquire({
        agentName: "test-main",
        channelThreadKey: "telegram:pin-resume",
      });
      await collectMessages(first.sendTurn({ prompt: "Start" }).events);
      await firstManager.shutdown();
      expect(opens.map((params) => params.model)).toEqual(["gpt-5.6-terra"]);

      // Entitlements improved while the session was cold. Tier resolution
      // would now pick Sol; the pin keeps the resume on Terra.
      state.codex.solAccess = true;
      const resumedManager = createAgentSessionManager(managerDeps(modelResolver));
      const runner = new AgentRunner(resumedManager);
      await collectMessages(
        runner.run({ agentName: "test-main", sessionId: first.sessionId, prompt: "Continue" }),
      );

      expect(opens).toHaveLength(2);
      expect(opens[1]).toMatchObject({
        model: "gpt-5.6-terra",
        isNewSession: false,
        providerThreadId: "codex-thread",
      });
      await resumedManager.shutdown();
    });

    it("an explicit selection overrides the pin and re-pins to the selected model", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      const codexOpens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens), claudeProvider(claudeOpens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });

      const repo = new SessionsRepository(testDb.db);
      // A session already pinned to Codex Terra.
      const pinnedId = await repo.create({
        agentName: "test-main",
        channelThreadKey: "webchat:override-pin",
        status: "active",
      });
      await repo.setProviderInfo(pinnedId, "openai", "codex-thread", "gpt-5.6-terra");

      // The guardian picks Claude Opus in the selector. Precedence is explicit
      // selection → pin → tier, so the selection wins over the pinned Terra and
      // the turn runs Opus — reusing the existing session, not a new chat.
      const manager = createAgentSessionManager(managerDeps(modelResolver));
      const session = await manager.acquire(
        { agentName: "test-main", channelThreadKey: "webchat:override-pin" },
        { selectionId: "claude-opus" },
      );
      expect(session.sessionId).toBe(pinnedId);

      const messages = await collectMessages(session.sendTurn({ prompt: "switch" }).events);
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: "claude-opus-4-8[1m]",
      });
      expect(claudeOpens).toHaveLength(1);
      expect(codexOpens).toHaveLength(0);
      // The successful turn re-pins the session to the model that actually ran.
      expect(await repo.findById(pinnedId)).toMatchObject({
        provider: "anthropic",
        model: "claude-opus-4-8[1m]",
      });
      await manager.shutdown();
    });

    it("a stranded pinned session becomes usable again through an explicit selection", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: false, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      const codexOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });

      const repo = new SessionsRepository(testDb.db);
      // A session pinned to Sol, whose access is now lost: the pin strands it.
      const strandedId = await repo.create({
        agentName: "test-main",
        channelThreadKey: "webchat:rescue",
        status: "active",
      });
      await repo.setProviderInfo(strandedId, "openai", "codex-thread", "gpt-5.6-sol");

      // Resuming on the pin alone fails closed — the pinned model cannot run and
      // there is no silent substitution, so acquiring the session throws the
      // structured resolution error rather than opening a backend.
      const failManager = createAgentSessionManager(managerDeps(modelResolver));
      await expect(
        failManager.acquire({ agentName: "test-main", channelThreadKey: "webchat:rescue" }),
      ).rejects.toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });
      expect(codexOpens).toHaveLength(0);
      await failManager.shutdown();

      // The guardian selects an available model (Terra). The very same session
      // runs again — no new chat — and re-pins to the selected model.
      const rescueManager = createAgentSessionManager(managerDeps(modelResolver));
      const rescueSession = await rescueManager.acquire(
        { agentName: "test-main", channelThreadKey: "webchat:rescue" },
        { selectionId: "gpt-5-6-terra" },
      );
      expect(rescueSession.sessionId).toBe(strandedId);

      const rescued = await collectMessages(rescueSession.sendTurn({ prompt: "use terra" }).events);
      expect(rescued.find((message) => message.type === "result")).toMatchObject({
        content: "gpt-5.6-terra",
      });
      expect(codexOpens.map((params) => params.model)).toEqual(["gpt-5.6-terra"]);
      expect(await repo.findById(strandedId)).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-terra",
      });
      await rescueManager.shutdown();
    });

    it("a legacy resume honors a persisted selection whose provider differs from the stored provider", async () => {
      const state = {
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      };
      const codexOpens: ModelSessionParams[] = [];
      const claudeOpens: ModelSessionParams[] = [];
      const modelResolver = createModelResolver({
        providers: [codexProvider(codexOpens), claudeProvider(claudeOpens)],
        aiToolState: { get: () => state, refresh: async () => state },
      });

      const repo = new SessionsRepository(testDb.db);
      // A pre-cutover row (model NULL) whose webchat key pins a Claude selection,
      // while the stored provider thread is Codex. With the resume guard removed,
      // the single precedence rule honors the persisted selection instead of
      // dropping it on provider mismatch.
      const legacyId = await repo.create({
        agentName: "test-main",
        channelThreadKey: "webchat:legacy-mismatch:large-model:claude-opus",
        status: "active",
      });
      await repo.setProviderInfo(legacyId, "openai", "codex-thread");

      const manager = createAgentSessionManager(managerDeps(modelResolver));
      const runner = new AgentRunner(manager);
      const messages = await collectMessages(
        runner.run({ agentName: "test-main", sessionId: legacyId, prompt: "Continue" }),
      );

      // The resume opens Claude Opus on a fresh provider thread (provider changed
      // from Codex), never the stored-provider tier resolution.
      expect(messages.find((message) => message.type === "result")).toMatchObject({
        content: "claude-opus-4-8[1m]",
      });
      expect(claudeOpens).toHaveLength(1);
      expect(claudeOpens[0]).toMatchObject({
        model: "claude-opus-4-8[1m]",
        isNewSession: true,
      });
      expect(claudeOpens[0].providerThreadId).toBeUndefined();
      expect(codexOpens).toHaveLength(0);
      await manager.shutdown();
    });
  });

  describe("tools", () => {
    it("forwards explicit threadContext into action execution", async () => {
      const actionRun = rs
        .spyOn(actionEngine, "run")
        .mockResolvedValue({ status: "ok", data: { ok: true } });

      actionRegistry.register({
        config: {
          name: "send_message",
          type: "system",
          description: "Send a message",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { text: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const runImplAction = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentMessage> {
        yield { type: "tool_use", id: "tu-send-1", tool: "send_message", input: { text: "hello" } };
        await params.executeAction("send_message", { text: "hello" });
        yield { type: "result", content: "Done" };
      };
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-action",
        builtinTools: new Set<string>(),
        openSession: makeOpenSessionFromRun("mock", runImplAction),
      };

      const runner = createRunner(provider);

      await collectMessages(
        runner.run({
          agentName: "test-all-actions",
          prompt: "Use action",
          channelThreadKey: "sentinel:telegram:thread-1",
          threadContext: {
            channel: "telegram",
            threadId: "thread-1",
            channelUserId: "user-1",
            threadName: "Dev Chat",
            threadType: "group",
            projectName: "alpha",
          },
        }),
      );

      expect(actionRun).toHaveBeenCalledWith(
        "send_message",
        { text: "hello" },
        expect.objectContaining({
          channelContext: {
            channel: "telegram",
            threadId: "thread-1",
            channelUserId: "user-1",
            threadName: "Dev Chat",
            threadType: "group",
            projectName: "alpha",
          },
          channelThreadKey: "sentinel:telegram:thread-1",
        }),
      );
    });

    it("passes an action catalog from the registry to the model provider", async () => {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Use tools" }));

      expect(provider.calls).toHaveLength(1);
      const toolNames = provider.calls[0].actionCatalog.map((t) => t.name);
      // demo_action is in test-main's tools list and registered in registry
      expect(toolNames).toContain("demo_action");
      expect(provider.calls[0].actionCatalog[0]).toMatchObject({
        description: "Schedule an event",
        sideEffects: "write",
        requiresApproval: false,
      });
    });

    it("expands wildcard action access to all registered agent-callable actions", async () => {
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });
      actionRegistry.register({
        config: {
          name: "send_message",
          type: "system",
          description: "Send a message",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { text: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });
      actionRegistry.register({
        config: {
          name: "workflow_only",
          type: "system",
          description: "Workflow only",
          complexity: "complex",
          speed: "slow",
          reliability: "high",
          sideEffects: "write",
        },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-all-actions", prompt: "Use all tools" }));

      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].actionCatalog.map((tool) => tool.name)).toEqual([
        "demo_action",
        "send_message",
      ]);
    });

    it("getActionCatalog reflects actions registered after the session opens (ZHA-98)", async () => {
      // Repro of the in-session app_management install flow: the provider's
      // facade tools (list_actions, execute_action) must observe registrations
      // that happen *after* openSession captured a snapshot. The session
      // exposes the live view via params.getActionCatalog and routes the
      // executeAction callback through the same allow-list-filtered lookup.
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-live-catalog",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-all-actions", prompt: "First turn" }));

      expect(captured).toHaveLength(1);
      const sessionParams = captured[0];
      expect(sessionParams.getActionCatalog).toBeDefined();
      expect(sessionParams.getActionCatalog!().map((a) => a.name)).toEqual(["demo_action"]);

      // Simulate `app_management` install finishing and the lifecycle manager
      // resync registering a new app action mid-session.
      const newActionExecutes: unknown[] = [];
      actionRegistry.register({
        config: {
          name: "repro_hello",
          type: "system",
          description: "Newly installed action",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async (input) => {
          newActionExecutes.push(input);
          return { status: "ok", data: { ok: true } };
        },
      });

      // The live getter now reports both actions to anything that reads it
      // (the facade tools' list_actions / search_actions / read_action).
      // Order is registry-insertion-order; sort for stable comparison.
      expect(
        sessionParams.getActionCatalog!()
          .map((a) => a.name)
          .sort(),
      ).toEqual(["demo_action", "repro_hello"]);

      // executeAction looks up against the same live, allow-list-filtered set
      // — so the agent can call the freshly-installed action from inside the
      // same conversation without rebinding the MCP token.
      const result = await sessionParams.executeAction("repro_hello", { name: "world" });
      expect(result).toEqual({ ok: true });
      expect(newActionExecutes).toEqual([{ name: "world" }]);
    });

    it("getActionCatalog still honors a non-wildcard agent allow-list", async () => {
      // Security regression guard: an agent yaml that scopes
      // `actions: [demo_action]` must never reach actions it didn't ask
      // for, even if those actions are present in the live registry.
      actionRegistry.register({
        config: {
          name: "demo_action",
          type: "system",
          description: "Schedule an event",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { name: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-allow-list",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };
      const runner = createRunner(provider);
      await collectMessages(runner.run({ agentName: "test-main", prompt: "First turn" }));

      const sessionParams = captured[0];

      // Register something outside `test-main`'s allow-list AFTER session open.
      actionRegistry.register({
        config: {
          name: "send_message",
          type: "system",
          description: "Send a message",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
        },
        inputSchema: { properties: { text: { type: "string" } } },
        execute: async () => ({ status: "ok", data: { ok: true } }),
      });

      expect(sessionParams.getActionCatalog!().map((a) => a.name)).toEqual(["demo_action"]);
      await expect(sessionParams.executeAction("send_message", { text: "x" })).rejects.toThrow(
        /Unknown action: send_message/,
      );
    });

    it("executeAction resolves a legacy name before checking the allow-list", async () => {
      const legacyBindings = createEmptyLegacyArtifactBindings();
      const actionId = formatArtifactId("review-app", "demo_action");
      claimLegacyArtifactName(legacyBindings, "action", "demo_action", actionId);
      actionRegistry = new ActionRegistryImpl([], { legacyBindings });
      actionEngine = new ActionEngine(actionRegistry);

      const executed: unknown[] = [];
      actionRegistry.register(
        {
          config: {
            name: "demo_action",
            type: "custom",
            description: "Review code",
            complexity: "simple",
            speed: "fast",
            reliability: "high",
            sideEffects: "read-only",
          },
          inputSchema: { properties: { path: { type: "string" } } },
          execute: async (input) => {
            executed.push(input);
            return { status: "ok", data: { reviewed: true } };
          },
        },
        {
          kind: "action",
          ownerType: "app",
          ownerId: "review-app",
          formatVersion: 1,
          publicName: "demo_action",
          aliases: [],
          sourcePath: "/tmp/review-app/actions/demo_action",
        },
      );

      const captured: ModelSessionParams[] = [];
      const provider: ModelProvider = {
        id: "mock",
        displayName: "mock-legacy-action",
        builtinTools: new Set<string>(),
        openSession: async (params) => {
          captured.push(params);
          return createSessionFromRun(
            "mock",
            async function* () {
              yield { type: "result", content: "Done" };
            },
            params,
          );
        },
      };

      await collectMessages(
        createRunner(provider).run({ agentName: "test-main", prompt: "Review" }),
      );

      expect(captured[0].getActionCatalog!().map((action) => action.name)).toEqual([actionId]);
      await expect(
        captured[0].executeAction("demo_action", { path: "src/index.ts" }),
      ).resolves.toEqual({ reviewed: true });
      expect(executed).toEqual([{ path: "src/index.ts" }]);
    });

    it("passes built-in tools from agent config to model provider", async () => {
      // test-main has tools: [Read, Edit, demo_action]
      // Mock provider with builtinTools matching Read and Edit
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      provider.builtinTools = new Set(["Read", "Edit", "Write", "Bash", "Glob", "Grep"]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Use tools" }));

      expect(provider.calls).toHaveLength(1);
      // builtinTools should contain only the built-in tools from test-main's config
      expect(provider.calls[0].builtinTools).toEqual(expect.arrayContaining(["Read", "Edit"]));
      expect(provider.calls[0].builtinTools).not.toContain("demo_action");
      expect(provider.calls[0].builtinTools).not.toContain("Write");
    });

    it("passes only agent-specific built-in tools (not all provider built-ins)", async () => {
      // test-explore has tools: [Read, Glob, Grep] — no Edit, no Write, no Bash
      const provider = new MockModelProvider([[{ type: "result", content: "Done" }]]);
      provider.builtinTools = new Set(["Read", "Edit", "Write", "Bash", "Glob", "Grep"]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-explore", prompt: "Search" }));

      expect(provider.calls).toHaveLength(1);
      const builtins = provider.calls[0].builtinTools!;
      expect(builtins).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
      expect(builtins).not.toContain("Edit");
      expect(builtins).not.toContain("Write");
      expect(builtins).not.toContain("Bash");
    });
  });

  describe("subagents", () => {
    it("passes subagent definitions for allowed subagents", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "Delegated" }]]);
      const runner = createRunner(provider);

      await collectMessages(runner.run({ agentName: "test-main", prompt: "Delegate" }));

      expect(provider.calls).toHaveLength(1);
      const toolNames = provider.calls[0].subagentTools.map((t) => t.name);
      // test-main has allowedSubagents: ["test-explore"]
      expect(toolNames).toContain("test-explore");

      const subagentTool = provider.calls[0].subagentTools.find((t) => t.name === "test-explore");
      expect(subagentTool).toBeDefined();
      expect(subagentTool!.description).toContain("test-explore");
      expect(subagentTool!.inputSchema).toHaveProperty("properties");
    });

    it("keeps nested subagent runtime messages out of the Parent stream and observer", async () => {
      const observerEvents: unknown[] = [];
      let delegatedOutput: unknown;
      const nestedCalls: import("./agent-runner.js").ModelRunParams[] = [];
      const runImplNested = async function* (
        params: import("./agent-runner.js").ModelRunParams,
      ): AsyncIterable<AgentMessage> {
        nestedCalls.push(params);

        if (nestedCalls.length === 1) {
          yield {
            type: "tool_use",
            id: "tu-explore-1",
            tool: "test-explore",
            input: { prompt: "Inspect" },
          };
          const output = await params.executeSubagent(
            "test-explore",
            { prompt: "Inspect" },
            { toolUseId: "tu-explore-1" },
          );
          delegatedOutput = output;
          yield { type: "tool_result", toolUseId: "tu-explore-1", tool: "test-explore", output };
          const earlyOutput = await params.executeSubagent(
            "test-explore",
            { prompt: "Inspect before provider event" },
            { toolUseId: "tu-explore-2" },
          );
          yield {
            type: "tool_use",
            id: "tu-explore-2",
            tool: "test-explore",
            input: { prompt: "Inspect before provider event" },
          };
          yield {
            type: "tool_result",
            toolUseId: "tu-explore-2",
            tool: "test-explore",
            output: earlyOutput,
          };
          yield { type: "result", content: "Delegated" };
          return;
        }

        yield { type: "text", content: "Scratchpad details" };
        yield { type: "thinking", content: "Investigating" };
        yield { type: "tool_use", id: "tu-lookup-1", tool: "lookup", input: { q: "details" } };
        yield {
          type: "tool_result",
          toolUseId: "tu-lookup-1",
          tool: "lookup",
          output: { ok: true },
        };
        yield { type: "result", content: "Explore complete" };
      };
      const provider: ModelProvider & { calls: import("./agent-runner.js").ModelRunParams[] } = {
        id: "mock",
        displayName: "mock-nested",
        builtinTools: new Set<string>(),
        calls: nestedCalls,
        openSession: makeOpenSessionFromRun("mock", runImplNested),
      };
      const runner = createRunner(provider);

      const messages = await actionExecutionContext.run(
        {
          executionId: "exec-1",
          rootExecutionId: "exec-1",
          initiator: "test",
          runtimeObserver: {
            onRuntimeEvent: (event) => observerEvents.push(event),
          },
        },
        () => collectMessages(runner.run({ agentName: "test-main", prompt: "Delegate" })),
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "subagent_start",
            toolUseId: "tu-explore-1",
            agentName: "test-explore",
            input: { prompt: "Inspect" },
            sessionId: expect.any(String),
            turnId: expect.any(String),
            agent: "test-main",
          }),
          expect.objectContaining({
            type: "subagent_result",
            toolUseId: "tu-explore-1",
            agentName: "test-explore",
            status: "completed",
            sessionId: expect.any(String),
            turnId: expect.any(String),
            output: "Explore complete",
            agent: "test-main",
          }),
          expect.objectContaining({
            type: "subagent_start",
            toolUseId: "tu-explore-2",
            agentName: "test-explore",
            sessionId: expect.any(String),
            turnId: expect.any(String),
            agent: "test-main",
          }),
          expect.objectContaining({
            type: "subagent_result",
            toolUseId: "tu-explore-2",
            agentName: "test-explore",
            status: "completed",
            agent: "test-main",
          }),
          expect.objectContaining({
            type: "result",
            content: "Delegated",
            agent: "test-main",
          }),
          expect.objectContaining({
            type: "turn_end",
            status: "completed",
            durationMs: expect.any(Number),
            agent: "test-main",
          }),
        ]),
      );
      expect(delegatedOutput).toEqual(
        expect.objectContaining({
          status: "completed",
          sessionId: expect.any(String),
          turnId: expect.any(String),
          output: "Explore complete",
        }),
      );
      const firstChild = messages.find(
        (message): message is Extract<AgentMessage, { type: "subagent_start" }> =>
          message.type === "subagent_start" && message.toolUseId === "tu-explore-1",
      );
      expect(firstChild).toBeDefined();
      const storedChild = await new WebChatRepository(testDb.db).getSession(firstChild!.sessionId);
      expect(storedChild).toMatchObject({
        type: "subagent",
        parentSessionId: "action:exec-1:test-main",
      });
      expect(
        messages.some((message) => "agent" in message && message.agent === "test-explore"),
      ).toBe(false);
      expect(observerEvents).toEqual([]);
    });
  });

  describe("outputSchema", () => {
    function structuredProvider(
      runImpl: (params: import("./agent-runner.js").ModelRunParams) => AsyncIterable<AgentMessage>,
    ): ModelProvider & { sessions: import("./agent-runner.js").ModelSessionParams[] } {
      const provider: ModelProvider & {
        sessions: import("./agent-runner.js").ModelSessionParams[];
      } = {
        id: "mock",
        displayName: "mock-structured",
        builtinTools: new Set<string>(),
        sessions: [],
        openSession: async (params) => {
          provider.sessions.push(params);
          return createSessionFromRun("mock", runImpl, params);
        },
      };
      return provider;
    }

    it("forwards outputSchema to the provider and returns its native structured result atomically", async () => {
      const payload = { decision: "REPLY", reason: "trivial" };
      const calls: import("./agent-runner.js").ModelRunParams[] = [];
      const provider = structuredProvider(async function* (params) {
        calls.push(params);
        yield { type: "result", content: "provider text is normalized", structuredOutput: payload };
      });
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.acquire({
        agentName: "test-structured",
        channelThreadKey: "test:structured-native",
      });

      const events: AgentMessage[] = [];
      for await (const msg of session.sendTurn({ prompt: "Triage." }).events) events.push(msg);

      expect(provider.sessions[0].outputSchema).toEqual(
        expect.objectContaining({ type: "object", required: ["decision", "reason"] }),
      );
      expect(calls[0].outputSchema).toEqual(provider.sessions[0].outputSchema);
      expect(provider.sessions[0].handback).toBeUndefined();
      expect(provider.sessions[0].executeSubmitOutput).toBeUndefined();
      expect(provider.sessions[0].systemPrompt).not.toContain("submit_output");
      expect(events.filter((event) => event.type === "result")).toEqual([
        expect.objectContaining({
          type: "result",
          content: JSON.stringify(payload),
          structuredOutput: payload,
        }),
      ]);
      expect(events.some((event) => event.type === "structured_output")).toBe(false);
    });

    it("fails the turn when provider-native output does not match the declared schema", async () => {
      const provider = structuredProvider(async function* () {
        yield {
          type: "result",
          content: "{}",
          structuredOutput: { decision: "NOPE", reason: "invalid enum" },
        };
      });
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.acquire({
        agentName: "test-structured",
        channelThreadKey: "test:structured-invalid",
      });

      const events: AgentMessage[] = [];
      for await (const msg of session.sendTurn({ prompt: "Triage." }).events) events.push(msg);

      expect(events.find((event) => event.type === "result")).toBeUndefined();
      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: expect.stringContaining("failed Rome validation"),
      });
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("fails the turn when a provider completes without structured output", async () => {
      const provider = structuredProvider(async function* () {
        yield { type: "result", content: "plain text" };
      });
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.acquire({
        agentName: "test-structured",
        channelThreadKey: "test:structured-missing",
      });

      const events: AgentMessage[] = [];
      for await (const msg of session.sendTurn({ prompt: "Triage." }).events) events.push(msg);

      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: expect.stringContaining("without structured output"),
      });
      expect(events.find((event) => event.type === "result")).toBeUndefined();
    });

    it("fails a suspended turn even if the provider later returns valid structured output", async () => {
      const payload = { decision: "REPLY", reason: "after approval" };
      const provider = structuredProvider(async function* () {
        yield {
          type: "tool_result",
          toolUseId: "tu-park",
          tool: "demo_action",
          output: { pendingApproval: true },
        };
        yield { type: "result", content: JSON.stringify(payload), structuredOutput: payload };
      });
      const manager = createAgentSessionManager(
        managerDeps(createTestModelResolver({ providers: [provider] })),
      );
      const session = await manager.acquire({
        agentName: "test-structured",
        channelThreadKey: "test:structured-suspended",
      });

      const events: AgentMessage[] = [];
      for await (const msg of session.sendTurn({ prompt: "Triage." }).events) events.push(msg);

      expect(events.find((event) => event.type === "result")).toBeUndefined();
      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: expect.stringContaining("cannot suspend"),
      });
      expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "error" });
    });

    it("does not configure provider-native output for an agent without outputSchema", async () => {
      const provider = new MockModelProvider([[{ type: "result", content: "ok" }]]);
      const runner = createRunner(provider);
      await collectMessages(runner.run({ agentName: "test-main", prompt: "hi" }));

      expect(provider.sessions).toHaveLength(1);
      expect(provider.sessions[0].outputSchema).toBeUndefined();
      expect(provider.sessions[0].handback).toBeUndefined();
    });
  });
});

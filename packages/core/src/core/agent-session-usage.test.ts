import { romeToolPorts } from "./rome-tool-ports.js";
import { createLogger } from "../logger.js";
import { readAnswerShape, romeSessionTracing } from "../agent/index.js";
import { TurnUsageReporter } from "../apps/turn-usage-reporter.js";
import { agentFolders } from "../paths.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { DrizzleSessionRepository } from "../agent/index.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/db.js";
import type { ModelSessionEvent, ModelSessionParams } from "../agent/index.js";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { AgentEvent } from "../types.js";
import type { ModelLoginKind } from "../agent/index.js";
import type { TurnUsageFacts } from "../agent/index.js";
import { AgentLoader } from "../apps/agent-loader.js";
import { TurnListeners } from "../agent/index.js";
import { AppTurnHooks } from "../apps/app-turn-hooks.js";
import { createSessionFromRun, type ModelProvider } from "./agent-runner.js";
import { createSessions, type Sessions } from "../agent/index.js";
import { createModelResolver } from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { SkillLoader } from "../apps/skill-loader.js";
import type { TurnMiddleware } from "../agent/index.js";
import type { ModelAccountReports } from "../agent/index.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import * as telemetry from "../telemetry.js" with { rstest: "importActual" };
import { reportOf, fakeAccounts, loginsOn } from "../test/kit/model-accounts.js";
import { startAfter } from "../test/turn-handle.js";

/** Lets the run finish sending, so what follows happens during the turn. */
const turnUnderway = () => new Promise<void>((resolve) => setImmediate(resolve));

const SOURCE_CHECKPOINT = {
  providerId: "openai",
  providerThreadId: "source-thread",
  checkpointId: "source-turn",
} as const;

const recordMetrics = rs.hoisted(() => rs.fn());
rs.mock("../telemetry.js", () => ({ ...telemetry, recordModelTurnMetrics: recordMetrics }));

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
  let manager: Sessions;
  let recorded: TurnUsageFacts[];
  // Each run decides whether it reaches the provider. One that does mints a
  // provider turn id, like Codex does on turn/start.
  let nextRun: () => AsyncIterable<AgentEvent | ModelSessionEvent>;
  let loginKind: ModelLoginKind | undefined;
  let forkLoginKind: ModelLoginKind | undefined;
  let beforeModelDispatch: (() => Promise<void>) | undefined;
  // Whether middleware ends the turn without reaching the model.
  let shortCircuit: boolean;
  // What the session does as it takes an input.
  let onSend: (() => void) | undefined;
  // Whether the model resolver sees Rome credits as the login.
  let resolverUsesRomeCredits: boolean;
  let state: ModelAccountReports;
  let providerCalls: number;
  let opened: ModelSessionParams[];

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
    recordMetrics.mockClear();
    loginKind = "api_credential";
    forkLoginKind = "api_credential";
    beforeModelDispatch = undefined;
    shortCircuit = false;
    onSend = undefined;
    resolverUsesRomeCredits = false;
    providerCalls = 0;
    opened = [];
    const provider: ModelProvider = {
      id: "openai",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        opened.push(params);
        if (params.thread.kind === "branch") {
          const fork = createSessionFromRun("openai", () => nextRun(), {
            ...params,
            thread: { kind: "new" },
          });
          Object.defineProperty(fork, "loginKind", { get: () => forkLoginKind });
          return fork;
        }
        const session = createSessionFromRun(
          "openai",
          () => {
            providerCalls++;
            return nextRun();
          },
          params,
        );
        Object.defineProperty(session, "loginKind", { get: () => loginKind });
        const send = session.sendUserInput.bind(session);
        // Like a real provider, it resolves once it accepts the input, not when
        // the turn ends.
        session.sendUserInput = async (input) => {
          onSend?.();
          void send(input);
        };
        return session;
      },
    };
    state = {
      openai: reportOf("available"),
      anthropic: reportOf("unauthorized"),
    };
    const actionRegistry = new ActionRegistryImpl();
    const systemPrompts = createTestSystemPrompts();
    rs.spyOn(systemPrompts, "build").mockReturnValue("Usage test prompt");
    const turnMiddleware: TurnMiddleware = {
      run: async (_ctx, terminal) => {
        await beforeModelDispatch?.();
        if (!shortCircuit) await terminal();
      },
    };
    manager = createSessions(
      {
        agentLoader: loader,
        sessionRepository: new DrizzleSessionRepository(testDb.db, artifactIdentity),
        systemPrompts,
        modelResolver: createModelResolver({
          providers: [provider],
          accounts: fakeAccounts(() => state),
          codexLogins: { login: () => loginsOn(resolverUsesRomeCredits).login() },
        }),
        networkMcpServers: () => ({}),
        skillCatalog: new SkillLoader(artifactIdentity),
        turnLifecycle: new TurnListeners(new AppTurnHooks()),
        readAnswerShape,
        folders: agentFolders(),
        log: createLogger("agent-session"),
        turnMiddleware,
        sessionTracing: romeSessionTracing,
        turnUsage: new TurnUsageReporter({
          usage: { recordTurn: (facts) => recorded.push(facts) },
        }),
        ...romeToolPorts({
          actionRegistry,
          actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
          sessionTools: async () => [
            {
              name: "say",
              description: "Say something",
              inputSchema: { type: "object" },
              handler: async () => ({ content: [{ type: "text", text: "said" }] }),
            },
          ],
        }),
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

  it("records each finished turn once with its accounting, login kind, and provider turn id", async () => {
    nextRun = async function* () {
      yield { type: "model_turn_started", modelTurnId: "provider-turn-1" };
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
    const session = await manager.open(key);
    const handle = await startAfter(session, { prompt: "hello" });
    await drain(handle.events());

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      turnId: handle.id,
      agentName: `core:${AGENT}`,
      status: "completed",
      provider: "openai",
      loginKind: "api_credential",
      providerTurnId: "provider-turn-1",
      accounting: { usage: { inputTokens: 10, outputTokens: 5 } },
    });
    // The run attributes the turn; the provider knows nothing of the agent.
    expect(recordMetrics).toHaveBeenCalledTimes(1);
    expect(recordMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-terra" }),
      { agentName: `core:${AGENT}`, appStoreListingId: undefined },
    );
  });

  it("does not hand a turn that never reached the provider the previous turn's id", async () => {
    let calls = 0;
    nextRun = async function* () {
      calls++;
      if (calls === 1) {
        yield { type: "model_turn_started", modelTurnId: "provider-turn-1" };
        yield { type: "result", content: "done" };
        return;
      }
      yield { type: "error", error: "rejected before the provider" };
    };
    const session = await manager.open(key);
    await drain((await startAfter(session, { prompt: "first" })).events());
    await drain((await startAfter(session, { prompt: "second" })).events());

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
        yield { type: "model_turn_started", modelTurnId: "provider-turn-1" };
        yield { type: "result", content: "done" };
        return;
      }
      yield { type: "error", error: "rejected before the provider" };
    };
    const session = await manager.open(key);
    const first = await startAfter(session, { prompt: "first" });
    const second = await startAfter(session, { prompt: "second" });
    await Promise.all([drain(first.events()), drain(second.events())]);

    expect(recorded.map((facts) => [facts.status, facts.providerTurnId])).toEqual([
      ["completed", "provider-turn-1"],
      ["error", undefined],
    ]);
  });

  it("ends a queued turn stopped before it reached the provider with no terminal", async () => {
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    nextRun = async function* () {
      await firstRelease;
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(key);
    const first = await startAfter(session, { prompt: "first" });
    const second = await startAfter(session, { prompt: "second" });

    expect(await second.stop("user-stop")).toBe("requested");
    releaseFirst();
    await Promise.all([drain(first.events()), drain(second.events())]);

    expect(await second.ended()).toEqual({ terminal: undefined, stoppedByRome: true });
    const said: string[] = [];
    for await (const event of second.events()) said.push(event.type);
    expect(said).not.toContain("result");
  });

  it("keeps the login kind from the turn's login when the login changes during it", async () => {
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

    const session = await manager.open(key);
    const first = await startAfter(session, { prompt: "ChatGPT-funded" });
    await firstStartedPromise;
    await turnUnderway();
    loginKind = "rome_credits";
    resolverUsesRomeCredits = true;
    releaseFirst();
    await drain(first.events());

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

    const second = await startAfter(session, { prompt: "Credit-funded" });
    await secondStartedPromise;
    await turnUnderway();
    loginKind = "subscription";
    releaseSecond();
    await drain(second.events());

    expect(recorded.map((facts) => facts.loginKind)).toEqual(["api_credential", "rome_credits"]);
  });

  it("records the login kind of the query that took the input", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    loginKind = "subscription";
    onSend = () => {
      loginKind = "api_credential";
    };
    const session = await manager.open(key);
    await drain((await startAfter(session, { prompt: "after a reopen" })).events());

    expect(recorded.map((facts) => facts.loginKind)).toEqual(["api_credential"]);
  });

  it("serves an exact fork its source's tools and refuses the ones that would act", async () => {
    nextRun = async function* () {
      yield {
        type: "result",
        content: "done",
        position: { provider: "openai", modelThreadId: "source-thread", checkpointId: "turn-1" },
      };
    };
    // A web chat shows cards and faces the guardian.
    const session = await manager.open(key, { drawsCards: true, guardianFacing: true });
    await drain((await startAfter(session, { prompt: "first" })).events());
    await drain(session.fork!({ prompt: "side question", mode: "exact" }));

    const [source, fork] = opened;
    const catalog = (params: ModelSessionParams) =>
      params.tools.listTools("ask_user").map((tool) => tool.name);
    expect(catalog(source)).toEqual(["ask_question", "defer", "say", "propose_routine"]);
    expect(catalog(fork)).toEqual(catalog(source));

    const say = await fork.tools.callTool("ask_user", "say", {});
    expect(say).toMatchObject({ isError: true });
    expect(say.content[0].text).toBe("say is unavailable in a forked turn.");
    const propose = await fork.tools.callTool("ask_user", "propose_routine", {
      kind: "manual",
      sentence: "Run it.",
      name: "Run",
      watchLabel: "On demand",
      thenSummary: "run it",
      actionName: "summon",
      args: {},
    });
    expect(propose).toMatchObject({ isError: true });
    expect(propose.content[0].text).toContain("NOT shown");
  });

  it("leaves no position to branch at after a turn that never reached the model", async () => {
    nextRun = async function* () {
      yield {
        type: "result",
        content: "done",
        position: { provider: "openai", modelThreadId: "source-thread", checkpointId: "turn-1" },
      };
    };
    const session = await manager.open(key);
    await drain((await startAfter(session, { prompt: "first" })).events());
    shortCircuit = true;
    await drain((await startAfter(session, { prompt: "parked on a card" })).events());

    const events: unknown[] = [];
    for await (const event of session.fork!({ prompt: "side question" })) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: "Cannot fork before a turn has left a checkpoint",
      }),
    );
  });

  it("dispatches a turn whose login kind resolves without a login change", async () => {
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
    loginKind = undefined;

    const session = await manager.open(key);
    const turn = await startAfter(session, { prompt: "boot-time turn" });
    await preparationStartedPromise;
    // The first status probe lands; Codex's login is still ChatGPT.
    loginKind = "subscription";
    releasePreparation();
    await drain(turn.events());

    expect(providerCalls).toBe(1);
    expect(recorded.map((facts) => facts.loginKind)).toEqual(["subscription"]);
  });

  it("keeps a forked turn's outcome when the consumer stops at its terminal block", async () => {
    nextRun = async function* () {
      yield { type: "model_turn_started", modelTurnId: "fork-provider-turn" };
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
    const session = await manager.open(key);
    for await (const event of session.fork!({
      prompt: "side question",
      checkpoint: SOURCE_CHECKPOINT,
    })) {
      if (event.type === "result") break;
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      sessionKind: "fork",
      status: "completed",
      providerTurnId: "fork-provider-turn",
      accounting: { usage: { inputTokens: 10, outputTokens: 5 } },
    });
    // The run attributes the turn; the provider knows nothing of the agent.
    expect(recordMetrics).toHaveBeenCalledTimes(1);
    expect(recordMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-terra" }),
      { agentName: `core:${AGENT}`, appStoreListingId: undefined },
    );
  });

  it("does not give a fork its source's login kind when Rome cannot tell the fork's", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(key);
    const events = session.fork!({
      prompt: "side question",
      checkpoint: SOURCE_CHECKPOINT,
    });
    forkLoginKind = undefined;
    for await (const _event of events) {
      // Runs the fork to its end.
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.loginKind).toBeUndefined();
  });

  it("finds a turn by id from its start, and replays it to a reader that comes after its end", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(key);
    const handle = await startAfter(session, { prompt: "hello" });
    expect(manager.turn(handle.id)).toBe(handle);
    await drain(handle.events());
    await handle.ended();

    const replayed: string[] = [];
    for await (const event of manager.turn(handle.id)!.events()) replayed.push(event.type);
    expect(replayed).toContain("result");
    expect(manager.turn("no-such-turn")).toBeUndefined();
  });

  it("finds a forked turn by id, and refuses to stop it", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(key);
    const events = session.fork!({
      prompt: "side question",
      checkpoint: SOURCE_CHECKPOINT,
    });
    const iterator = events[Symbol.asyncIterator]();
    const start = (await iterator.next()).value as StreamAgentEvent;
    if (start.type !== "turn_start") throw new Error("expected turn_start");

    const forked = manager.turn(start.turnId);
    expect(forked).toBeDefined();
    expect(await forked!.stop("user-stop")).toBe("cannot_stop");
    while (!(await iterator.next()).done) {
      // Read the fork to its end.
    }

    expect(forked!.hasEnded).toBe(true);
    expect((await forked!.ended()).terminal).toMatchObject({ type: "result", content: "done" });
    const replayed: string[] = [];
    for await (const event of forked!.events()) replayed.push(event.type);
    expect(replayed[0]).toBe("turn_start");
    expect(replayed).toContain("result");
  });

  it("records a forked turn under its fork session", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(key);
    const events = session.fork!({
      prompt: "side question",
      checkpoint: SOURCE_CHECKPOINT,
    });
    let forkSessionId: string | undefined;
    for await (const event of events) {
      if (event.type === "turn_start") forkSessionId = event.sessionId;
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      romeSessionId: forkSessionId,
      sessionKind: "fork",
      status: "completed",
      loginKind: "api_credential",
    });
  });
});

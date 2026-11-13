import { romeToolPorts } from "./rome-tool-ports.js";
import { createLogger } from "../logger.js";
import { readAnswerShape, romeSessionTracing } from "../agent/index.js";
import { TurnUsageReporter } from "../app-host/turn-usage-reporter.js";
import { agentFolders } from "../paths.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { DrizzleSessionRepository } from "../agent/index.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/db.js";
import type { ModelSession, ModelSessionEvent } from "../agent/index.js";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { AgentEvent } from "../types.js";
import { AgentLoader } from "../app-host/agent-loader.js";
import { TurnListeners } from "../agent/index.js";
import { AppTurnHooks } from "../app-host/app-turn-hooks.js";
import { createSessionFromRun, type ModelProvider } from "./agent-runner.js";
import { createSessions, type Sessions } from "../agent/index.js";
import { createModelResolver } from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { SkillLoader } from "../app-host/skill-loader.js";
import type { ModelAccountReports } from "../agent/index.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { reportOf, fakeAccounts, loginsOn } from "../test/kit/model-accounts.js";
import { startAfter } from "../test/turn-handle.js";

const AGENT = "events_loop_agent";
const key = { agentName: AGENT, channelThreadKey: "webchat:events-loop-test" };

/** The turn's events, read to its end. */
async function collect(events: AsyncIterable<StreamAgentEvent>): Promise<StreamAgentEvent[]> {
  const seen: StreamAgentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("AgentSession events loop", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: Sessions;
  let repository: DrizzleSessionRepository;
  let nextRun: () => AsyncIterable<AgentEvent | ModelSessionEvent>;
  let opened: ModelSession[];
  let closeCalls: number;
  // Whether the provider's event stream throws after its first event.
  let streamBreaks: boolean;
  const log = createLogger("agent-session");
  let state: ModelAccountReports;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-events-loop-"));
    await writeFile(
      join(directory, `${AGENT}.yaml`),
      JSON.stringify({
        name: AGENT,
        description: "Events loop fixture",
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
    repository = new DrizzleSessionRepository(testDb.db);
    opened = [];
    closeCalls = 0;
    streamBreaks = false;
    const provider: ModelProvider = {
      id: "openai",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        const session = createSessionFromRun("openai", () => nextRun(), params);
        const close = session.close.bind(session);
        session.close = async () => {
          closeCalls++;
          await close();
        };
        if (streamBreaks) {
          const original = session.events;
          Object.defineProperty(session, "events", {
            value: {
              async *[Symbol.asyncIterator]() {
                for await (const event of original) {
                  yield event;
                  throw new Error("provider stream broke");
                }
              },
            },
          });
        }
        opened.push(session);
        return session;
      },
    };
    state = {
      openai: reportOf("available"),
      anthropic: reportOf("unauthorized"),
    };
    const actionRegistry = new ActionRegistryImpl();
    const systemPrompts = createTestSystemPrompts();
    rs.spyOn(systemPrompts, "build").mockReturnValue("Events loop test prompt");
    manager = createSessions(
      {
        agentLoader: loader,
        sessionRepository: repository,
        systemPrompts,
        modelResolver: createModelResolver({
          providers: [provider],
          accounts: fakeAccounts(() => state),
          codexLogins: { login: () => loginsOn(false).login() },
        }),
        networkMcpServers: () => ({}),
        skillCatalog: new SkillLoader(artifactIdentity),
        turnLifecycle: new TurnListeners(new AppTurnHooks()),
        readAnswerShape,
        folders: agentFolders(),
        log,
        turnMiddleware: { run: async (_ctx, terminal) => void (await terminal()) },
        sessionTracing: romeSessionTracing,
        turnUsage: new TurnUsageReporter({ usage: { recordTurn: () => undefined } }),
        ...romeToolPorts({
          actionRegistry,
          actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
          sessionTools: async () => [],
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

  it("closes the model session and ends the turn with the real error", async () => {
    streamBreaks = true;
    nextRun = async function* () {
      yield { type: "text", content: "partial answer" };
      // The provider has more to do; it stays running until it is closed.
      await new Promise<void>(() => undefined);
    };
    const session = await manager.open(key);
    const handle = await startAfter(session, { prompt: "hello" });
    const seen = await collect(handle.events());

    // The error is the turn's terminal; turn_end only brackets it.
    const errors = seen.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error: expect.stringContaining("provider stream broke") });
    expect(seen.at(-1)?.type).toBe("turn_end");
    expect(closeCalls).toBe(1);
    expect(opened).toHaveLength(1);
  });

  it("keeps the turn going when recording the session's activity fails", async () => {
    const warn = rs.spyOn(log, "warn");
    const save = rs.spyOn(repository, "save").mockRejectedValue(new Error("database is locked"));
    nextRun = async function* () {
      yield { type: "text", content: "partial answer" };
      yield { type: "result", content: "the answer" };
    };
    const session = await manager.open(key);
    const seen = await collect((await startAfter(session, { prompt: "hello" })).events());

    expect(seen.map((event) => event.type)).not.toContain("error");
    expect(seen.filter((event) => event.type === "result")).toHaveLength(1);
    expect(seen.at(-1)?.type).toBe("turn_end");
    expect(save).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "failed to touch session",
      expect.objectContaining({ error: "database is locked" }),
    );
    expect(closeCalls).toBe(0);
  });

  it("closes the model session once when the session is closed on purpose", async () => {
    nextRun = async function* () {
      yield { type: "result", content: "done" };
    };
    const session = await manager.open(key);
    await collect((await startAfter(session, { prompt: "hello" })).events());
    expect(closeCalls).toBe(0);

    await session.close("user");
    expect(closeCalls).toBe(1);
  });
});

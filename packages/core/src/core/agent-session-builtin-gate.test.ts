import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/helpers.js";
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
import type { ThreadContext } from "./types.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { testChannelSurface } from "../test/channel-surface.js";

const AGENT = "gate_agent";
const key = { agentName: AGENT, channelThreadKey: "telegram:chat-1" };

function thread(senderBondLevel: string): ThreadContext {
  return { channel: "telegram", threadId: "chat-1", senderBondLevel };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Consume the turn to its end.
  }
}

describe("AgentSession built-in tool gate", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
  // What each turn's provider saw for Bash and Read while the turn ran.
  let sourceTurns: Array<{ bash: boolean; read: boolean }>;
  let forkTurns: Array<{ bash: boolean; read: boolean }>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-builtin-gate-"));
    await writeFile(
      join(directory, `${AGENT}.yaml`),
      JSON.stringify({
        name: AGENT,
        description: "Built-in tool gate fixture",
        provider: "anthropic",
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
    sourceTurns = [];
    forkTurns = [];
    const runGated = (
      params: Pick<ModelSessionForkOpenParams, "isBuiltinToolAllowed">,
      turns: Array<{ bash: boolean; read: boolean }>,
    ) =>
      async function* () {
        const allowed = params.isBuiltinToolAllowed ?? (() => true);
        turns.push({ bash: allowed("Bash"), read: allowed("Read") });
        yield { type: "result" as const, content: "done" };
      };
    const provider: ModelProvider = {
      id: "anthropic",
      displayName: "anthropic",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        const session = createSessionFromRun("anthropic", runGated(params, sourceTurns), params);
        session.fork = async (fork) => ({
          providerId: "anthropic",
          sessionId: fork.sessionId,
          sourceSessionId: params.sessionId,
          mode: fork.mode ?? "ephemeral",
          open: async (forkParams) =>
            createSessionFromRun(
              "anthropic",
              runGated(forkParams, forkTurns),
              forkParams as typeof params,
            ),
        });
        return session;
      },
    };
    const state = {
      codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      claude: { loggedIn: true, quotaExhausted: false },
    };
    const actionRegistry = new ActionRegistryImpl();
    const promptBuilder = new PromptBuilder();
    const sessionsRepo = new SessionsRepository(testDb.db);
    rs.spyOn(promptBuilder, "build").mockReturnValue("Gate test prompt");
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
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(artifactIdentity),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
        channelSurface: testChannelSurface,
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

  it("limits a stranger's turn to reading, and only that turn", async () => {
    const session = await manager.acquire(key, { threadContext: thread("guardian") });
    await drain(
      session.sendTurn({ prompt: "stranger" }, { threadContext: thread("other") }).events,
    );
    await drain(
      session.sendTurn({ prompt: "guardian" }, { threadContext: thread("guardian") }).events,
    );

    expect(sourceTurns).toEqual([
      { bash: false, read: true },
      { bash: true, read: true },
    ]);
  });

  it("checks an exact fork's turn against the fork's thread, not the source's", async () => {
    const session = await manager.acquire(key, { threadContext: thread("guardian") });
    await drain(session.sendTurn({ prompt: "warm up" }).events);
    await drain(
      session.runForkedTurn!({
        prompt: "side question",
        mode: "exact",
        threadContext: thread("other"),
      }),
    );

    expect(sourceTurns).toEqual([{ bash: true, read: true }]);
    expect(forkTurns).toEqual([{ bash: false, read: true }]);
  });
});

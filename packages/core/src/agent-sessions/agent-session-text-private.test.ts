import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { testChannelSurface } from "../test/channel-surface.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/helpers.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { AgentLoader } from "../core/agent-loader.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelSessionParams,
} from "../core/agent-runner.js";
import { createTestSessionManager, type TestSessionManager } from "../test/session-compat.js";
import { CapabilityDiscovery } from "../core/capability-discovery.js";
import { createModelResolver } from "../core/model-resolver.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "../core/skill-catalog.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

describe("TestSessionManager textPrivate", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: TestSessionManager;
  let opened: ModelSessionParams[];

  async function writeAgent(name: string, policy?: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(directory, `${name}.yaml`),
      JSON.stringify({
        name,
        description: "textPrivate fixture",
        provider: "anthropic",
        tier: "medium",
        systemPromptPrefix: "Complete the task.",
        tools: [],
        permissionMode: "default",
        ...(policy ? { policy } : {}),
      }),
    );
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-text-private-"));
    await writeAgent("texter", { finalText: "private" });
    await writeAgent("worker");
    const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    const loader = new AgentLoader(artifactIdentity);
    await loader.loadAll(directory);
    testDb = createTestDb();
    const sessionsRepo = new SessionsRepository(testDb.db);
    opened = [];
    const provider: ModelProvider = {
      id: "anthropic",
      displayName: "anthropic",
      builtinTools: new Set<string>(),
      openSession: async (params) => {
        opened.push(params);
        return createSessionFromRun(
          "anthropic",
          async function* () {
            yield { type: "result", content: "done" };
          },
          params,
        );
      },
    };
    const state = {
      codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      claude: { loggedIn: true, quotaExhausted: false },
    };
    const actionRegistry = new ActionRegistryImpl();
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("textPrivate test prompt");
    manager = createTestSessionManager(
      {
        agentLoader: loader,
        sessionManager: new SessionManager(sessionsRepo, artifactIdentity),
        sessionsRepo,
        webchatRepo: new ChatsWebChatRepository(testDb.db),
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

  it.each([
    ["texter", true],
    ["worker", false],
  ])("opens %s's model session with textPrivate %s", async (agentName, textPrivate) => {
    await manager.acquire(
      { agentName, channelThreadKey: `webchat:${agentName}` },
      { workingDir: directory },
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.textPrivate).toBe(textPrivate);
  });
});

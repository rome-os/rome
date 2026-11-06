import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { DrizzleSessionRepository } from "../agent/index.js";
import { testChannelSurface } from "../test/channel-surface.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/helpers.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { AgentLoader } from "./agent-loader.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelSessionParams,
} from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SkillCatalog } from "./skill-catalog.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

describe("AgentSessionManager textPrivate", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
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
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionRepository: new DrizzleSessionRepository(testDb.db, artifactIdentity),
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
  ])("opens %s's model session with a defer tool that asks for a confirmation line: %s", async (agentName, textPrivate) => {
    await manager.acquire(
      { agentName, channelThreadKey: `webchat:${agentName}` },
      { workingDir: directory },
    );
    expect(opened).toHaveLength(1);
    // A private-text agent's words never reach the guardian, so `defer` asks
    // it for no confirmation line.
    const defer = opened[0]!.tools.listTools("ask_user").find((tool) => tool.name === "defer");
    expect(defer).toBeDefined();
    expect(defer!.description.includes("write one short line confirming")).toBe(!textPrivate);
  });
});

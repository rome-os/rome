import { romeToolPorts } from "./rome-tool-ports.js";
import { createLogger } from "../logger.js";
import { ChatSessionSettings, readAnswerShape, TurnUsageReporter } from "../agent/index.js";
import { agentFolders } from "../paths.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { DrizzleSessionRepository } from "../agent/index.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/db.js";
import { AppTurnHooks, TurnListeners } from "../agent/index.js";
import { AgentLoader } from "../agent/index.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelSessionParams,
} from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { createModelResolver } from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { SkillLoader } from "../agent/index.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { reportOf, fakeAccounts } from "../test/kit/model-accounts.js";

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
      openai: reportOf("unauthorized"),
      anthropic: reportOf("available"),
    };
    const actionRegistry = new ActionRegistryImpl();
    const systemPrompts = createTestSystemPrompts();
    rs.spyOn(systemPrompts, "build").mockReturnValue("textPrivate test prompt");
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionRepository: new DrizzleSessionRepository(testDb.db, artifactIdentity),
        sessionSettings: new ChatSessionSettings({
          webchatRepo: new ChatsWebChatRepository(testDb.db),
        }),
        systemPrompts,
        modelResolver: createModelResolver({
          providers: [provider],
          accounts: fakeAccounts(() => state),
        }),
        networkMcpServers: () => ({}),
        skillCatalog: new SkillLoader(artifactIdentity),
        turnLifecycle: new TurnListeners(new AppTurnHooks()),
        readAnswerShape,
        turnUsage: new TurnUsageReporter(),
        folders: agentFolders(),
        log: createLogger("agent-session"),
        ...romeToolPorts({
          webchatRepo: new ChatsWebChatRepository(testDb.db),
          actionRegistry,
          actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
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

  it.each([
    ["texter", true],
    ["worker", false],
  ])("opens %s's model session with a defer tool that asks for a confirmation line: %s", async (agentName, textPrivate) => {
    await manager.acquire(
      { agentName, channelThreadKey: `webchat:${agentName}` },
      // A web chat faces the guardian, so a wake-up can be scheduled into it.
      { workingDir: directory, guardianFacing: true },
    );
    expect(opened).toHaveLength(1);
    // A private-text agent's words never reach the guardian, so `defer` asks
    // it for no confirmation line.
    const defer = opened[0]!.tools.listTools("ask_user").find((tool) => tool.name === "defer");
    expect(defer).toBeDefined();
    expect(defer!.description.includes("write one short line confirming")).toBe(!textPrivate);
  });
});

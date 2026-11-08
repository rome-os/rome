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
import type { SessionToolContext } from "./session-tools.js";
import { createModelResolver } from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { SkillLoader } from "../agent/index.js";
import { reportOf, fakeAccounts } from "../test/kit/model-accounts.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

describe("AgentSession turn push level", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
  let opened: ModelSessionParams[];
  let tools: SessionToolContext | undefined;

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
    directory = await mkdtemp(join(tmpdir(), "rome-agent-push-level-"));
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
          // Reads the level as a session tool would, mid-turn.
          async function* () {
            yield { type: "result", content: tools?.getTurnPushLevel() ?? "none" };
          },
          params,
        );
      },
    };

    const actionRegistry = new ActionRegistryImpl();
    const systemPrompts = createTestSystemPrompts();
    rs.spyOn(systemPrompts, "build").mockReturnValue("push level test prompt");
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
          accounts: fakeAccounts({
            anthropic: reportOf("available"),
            openai: reportOf("unauthorized"),
          }),
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
          sessionTools: async (context) => {
            tools = context;
            return [];
          },
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

  const resultOf = async (pushLevel?: "active" | "passive") => {
    const session = await manager.acquire(
      { agentName: "worker", channelThreadKey: "webchat:worker" },
      { workingDir: directory },
    );
    const handle = session.sendTurn({ prompt: "go" }, pushLevel ? { pushLevel } : {});
    let result: string | undefined;
    for await (const event of handle.events) {
      if (event.type === "result") result = event.content;
    }
    return result;
  };

  it("shows session tools the running turn's push level, and none for a turn without one", async () => {
    expect(await resultOf("passive")).toBe("passive");
    expect(await resultOf()).toBe("none");
    expect(tools?.getTurnPushLevel()).toBeUndefined();
  });
});

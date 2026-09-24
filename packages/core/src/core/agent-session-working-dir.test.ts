import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { createSessionFromRun, type ModelProvider } from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";

const AGENT = "worker";

describe("AgentSessionManager.findWorkingDirBySessionId", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-working-dir-"));
    await writeFile(
      join(directory, `${AGENT}.yaml`),
      JSON.stringify({
        name: AGENT,
        description: "Working dir lookup fixture",
        provider: "anthropic",
        tier: "medium",
        systemPromptPrefix: "Complete the task.",
        tools: [],
        permissionMode: "default",
      }),
    );
    const loader = new AgentLoader();
    await loader.loadAll(directory);
    testDb = createTestDb();
    const provider: ModelProvider = {
      id: "anthropic",
      displayName: "anthropic",
      builtinTools: new Set<string>(),
      openSession: async (params) =>
        createSessionFromRun(
          "anthropic",
          async function* () {
            yield { type: "result", content: "done" };
          },
          params,
        ),
    };
    const state = {
      codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      claude: { loggedIn: true, quotaExhausted: false },
    };
    const actionRegistry = new ActionRegistryImpl([]);
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("Working dir test prompt");
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager: new SessionManager(new SessionsRepository(testDb.db)),
        promptBuilder,
        actionRegistry,
        actionEngine: new ActionEngine(actionRegistry),
        modelResolver: createModelResolver({
          providers: [provider],
          aiToolState: { get: () => state, refresh: async () => state },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
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

  it("finds open sessions and the subagent sessions they own, and forgets closed ones", async () => {
    const parentDir = join(directory, "parent-project");
    const childDir = join(directory, "child-project");
    await mkdir(parentDir);
    await mkdir(childDir);

    const parent = await manager.acquire(
      { agentName: AGENT, channelThreadKey: "webchat:working-dir" },
      { workingDir: parentDir },
    );
    const childManager = (parent as unknown as { childManager: AgentSessionManager }).childManager;
    const child = await childManager.acquire(
      { agentName: AGENT, channelThreadKey: "webchat:working-dir:subagent:1" },
      { workingDir: childDir },
    );

    expect(manager.findWorkingDirBySessionId!(parent.sessionId)).toBe(parentDir);
    expect(manager.findWorkingDirBySessionId!(child.sessionId)).toBe(childDir);
    expect(manager.findWorkingDirBySessionId!("no-such-session")).toBeUndefined();

    await parent.close("user");
    expect(manager.findWorkingDirBySessionId!(parent.sessionId)).toBeUndefined();
    expect(manager.findWorkingDirBySessionId!(child.sessionId)).toBeUndefined();
  });
});

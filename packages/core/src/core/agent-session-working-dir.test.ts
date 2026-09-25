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

describe("AgentSessionManager working dirs", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
  let sessionsRepo: SessionsRepository;
  const previousProjectsRoot = process.env.ROME_PROJECTS_ROOT;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-working-dir-"));
    process.env.ROME_PROJECTS_ROOT = join(directory, "projects");
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
    sessionsRepo = new SessionsRepository(testDb.db);
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
        sessionManager: new SessionManager(sessionsRepo),
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
    if (previousProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = previousProjectsRoot;
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

  it("finds the source session's working dir for an action called from its forked turn", async () => {
    const parentDir = join(directory, "parent-project");
    await mkdir(parentDir);
    const parent = await manager.acquire(
      { agentName: AGENT, channelThreadKey: "webchat:fork" },
      { workingDir: parentDir },
    );

    const fork = parent.runForkedTurn!({ prompt: "side question" })[Symbol.asyncIterator]();
    const start = await fork.next();
    if (start.done || start.value.type !== "turn_start") throw new Error("expected turn_start");
    const forkSessionId = start.value.sessionId;
    expect(manager.findWorkingDirBySessionId!(forkSessionId)).toBe(parentDir);

    while (!(await fork.next()).done) {}
    expect(manager.findWorkingDirBySessionId!(forkSessionId)).toBeUndefined();
  });

  it("resumes a session by id in the working dir it was created in", async () => {
    const projectDir = join(directory, "site");
    await mkdir(projectDir);
    const original = await manager.acquire(
      { agentName: AGENT, channelThreadKey: "action:resume" },
      { workingDir: projectDir },
    );
    const sessionId = original.sessionId;
    await original.close("idle");

    const resumed = await manager.acquireBySessionId!(sessionId, AGENT);

    expect(resumed.sessionId).toBe(sessionId);
    expect(manager.findWorkingDirBySessionId!(sessionId)).toBe(projectDir);
  });

  it("reuses a session by channel-thread key in the working dir it was created in", async () => {
    const projectDir = join(directory, "site");
    await mkdir(projectDir);
    const key = { agentName: AGENT, channelThreadKey: "inbox:telegram:thread-1" };
    const original = await manager.acquire(key, { workingDir: projectDir });
    const sessionId = original.sessionId;
    await original.close("idle");

    const reused = await manager.acquire(key);

    expect(reused.sessionId).toBe(sessionId);
    expect(manager.findWorkingDirBySessionId!(sessionId)).toBe(projectDir);
  });

  it("refuses to resume a session whose recorded working dir is gone", async () => {
    const projectDir = join(directory, "renamed-later");
    await mkdir(projectDir);
    const original = await manager.acquire(
      { agentName: AGENT, channelThreadKey: "action:gone" },
      { workingDir: projectDir },
    );
    await original.close("idle");
    await rm(projectDir, { recursive: true });

    await expect(manager.acquireBySessionId!(original.sessionId, AGENT)).rejects.toThrow(
      "which no longer exists",
    );
  });

  it("resumes a legacy session with no recorded working dir in the default project", async () => {
    await sessionsRepo.create({
      id: "legacy-session",
      agentName: AGENT,
      channelThreadKey: "action:legacy",
    });

    await manager.acquireBySessionId!("legacy-session", AGENT);

    expect(manager.findWorkingDirBySessionId!("legacy-session")).toBe(
      join(directory, "projects", "default"),
    );
  });
});

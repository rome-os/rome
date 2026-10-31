import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { testChannelSurface } from "../test/channel-surface.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/helpers.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelSessionParams,
} from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createRomeMcpServerForSession } from "./mcp/server.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog, type SkillMcpDefinition } from "./skill-catalog.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const SKILL: SkillMcpDefinition = {
  name: "notes:filing",
  description: "How the guardian files notes",
  content: "# Filing\n\nThe guardian's private filing steps.",
  ownerType: "app",
  ownerId: "notes",
};

function agentYaml(name: string, actions?: string[]): string {
  return JSON.stringify({
    name,
    description: "Skill visibility fixture",
    provider: "anthropic",
    tier: "small",
    systemPromptPrefix: "Complete the task.",
    tools: [],
    ...(actions ? { actions } : {}),
    permissionMode: "default",
  });
}

describe("AgentSessionManager skill tools", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: AgentSessionManager;
  let opened: ModelSessionParams[];
  const previousProjectsRoot = process.env.ROME_PROJECTS_ROOT;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-skills-"));
    process.env.ROME_PROJECTS_ROOT = join(directory, "projects");
    await copyFile(
      join(REPO, "rome_apps/inbox/src/agents/sentinel.yaml"),
      join(directory, "sentinel.yaml"),
    );
    await writeFile(join(directory, "omits-actions.yaml"), agentYaml("omits-actions"));
    await writeFile(join(directory, "holds-actions.yaml"), agentYaml("holds-actions", ["*"]));
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
    const skillCatalog = new SkillCatalog(artifactIdentity);
    rs.spyOn(skillCatalog, "getMcpDefinitions").mockReturnValue([SKILL]);
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("Skill visibility test prompt");
    const actionRegistry = new ActionRegistryImpl();
    manager = createAgentSessionManager({
      agentLoader: loader,
      sessionManager: new SessionManager(sessionsRepo, artifactIdentity),
      sessionsRepo,
      webchatRepo: new WebChatRepository(testDb.db),
      promptBuilder,
      actionRegistry,
      actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
      modelResolver: createModelResolver({
        providers: [provider],
        aiToolState: { get: () => state, refresh: async () => state },
      }),
      capabilityDiscovery: new CapabilityDiscovery(),
      skillCatalog,
      lifecycleDispatcher: createAgentLifecycleDispatcher(),
      channelSurface: testChannelSurface,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    testDb.close();
    await rm(directory, { recursive: true, force: true });
    if (previousProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = previousProjectsRoot;
    rs.restoreAllMocks();
  });

  async function skillToolsFor(agentName: string) {
    const openedBefore = opened.length;
    await manager.acquire(
      { agentName, channelThreadKey: `test:skills:${agentName}` },
      { workingDir: directory },
    );
    const params = opened[openedBefore];
    if (!params) throw new Error(`no model session opened for ${agentName}`);
    const server = createRomeMcpServerForSession(params);
    return {
      list: () => server.callTool("skills", "list_skills"),
      search: () => server.callTool("skills", "search_skills", { query: "." }),
      read: () => server.callTool("skills", "read_skill", { skill_name: SKILL.name }),
    };
  }

  it.each([
    ["the inbox sentinel (actions: [])", "sentinel"],
    ["an agent that omits actions", "omits-actions"],
  ])("%s cannot list, search, or read a skill", async (_label, agentName) => {
    const tools = await skillToolsFor(agentName);

    expect(JSON.parse((await tools.list()).content[0]!.text)).toEqual([]);
    expect(JSON.parse((await tools.search()).content[0]!.text)).toEqual([]);
    const read = await tools.read();
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toContain(`Unknown skill: ${SKILL.name}`);
    expect(read.content[0]!.text).not.toContain(SKILL.content);
  });

  it("keeps every skill for an agent that holds actions", async () => {
    const tools = await skillToolsFor("holds-actions");

    const listed = JSON.parse((await tools.list()).content[0]!.text) as Array<{ name: string }>;
    expect(listed.map((skill) => skill.name)).toEqual([SKILL.name]);
    const found = JSON.parse((await tools.search()).content[0]!.text) as Array<{ name: string }>;
    expect(found.map((skill) => skill.name)).toEqual([SKILL.name]);
    const read = await tools.read();
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(read.content[0]!.text)).toEqual({ name: SKILL.name, content: SKILL.content });
  });
});

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { getProfileMemoryDir } from "../paths.js";
import { createTestDb, MockModelProvider, type TestDb } from "../test/helpers.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";

describe("persisted session isolation at provider open", () => {
  let root: string;
  let db: TestDb;
  let repo: WebChatRepository;
  let model: MockModelProvider;
  let manager: AgentSessionManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rome-session-isolation-"));
    rs.stubEnv("HOME", root);
    rs.stubEnv("ROME_PROFILE", "test");
    rs.stubEnv("ROME_PROJECTS_ROOT", root);
    const memory = getProfileMemoryDir();
    await mkdir(join(memory, "projects", "navi-bench"), { recursive: true });
    await writeFile(join(memory, "MEMORY.md"), "SECRET-MEMORY");
    await writeFile(join(memory, "IDENTITY.md"), "SECRET-IDENTITY");
    await writeFile(join(memory, "projects", "navi-bench", "PROJECT.md"), "SECRET-PROJECT");
    await writeFile(
      join(root, "main.yaml"),
      JSON.stringify({
        name: "main",
        description: "Fixture",
        permissionMode: "default",
        tier: "large",
        systemPromptPrefix: "Keep safety instructions",
        tools: [],
      }),
    );
    const loader = new AgentLoader();
    await loader.loadAll(root);
    db = createTestDb();
    repo = new WebChatRepository(db.db);
    model = new MockModelProvider(
      Array.from({ length: 10 }, () => [{ type: "result" as const, content: "done" }]),
    );
    const registry = new ActionRegistryImpl([]);
    const catalog = {
      listResolved: () => [
        { appId: "navi-bench", manifest: { description: "SECRET-APP" } },
        { appId: "notes", manifest: { description: "Notes stay available" } },
      ],
    } as unknown as ConstructorParameters<typeof PromptBuilder>[0];
    manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager: new SessionManager(new SessionsRepository(db.db)),
        promptBuilder: new PromptBuilder(catalog),
        webchatRepo: repo,
        actionRegistry: registry,
        actionEngine: new ActionEngine(registry),
        modelResolver: createModelResolver({
          providers: [model],
          aiToolState: {
            get: () => ({
              codex: {
                loggedIn: false,
                quotaExhausted: false,
                solAccess: false,
                lunaAccess: false,
              },
              claude: { loggedIn: true, quotaExhausted: false },
            }),
            refresh: async () => ({
              codex: {
                loggedIn: false,
                quotaExhausted: false,
                solAccess: false,
                lunaAccess: false,
              },
              claude: { loggedIn: true, quotaExhausted: false },
            }),
          },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
      },
      { keepAliveAcrossTurns: true },
    );
  });

  afterEach(async () => {
    await manager?.shutdown();
    db?.close();
    rs.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("reloads durable isolation on reopen and cannot unset it through runtime init", async () => {
    const metadata = { isolated: true, purpose: "benchmark", appId: "navi-bench" };
    await repo.createSession(
      "isolated",
      "Executor",
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      "webchat",
      null,
      metadata,
    );
    await repo.createSession("normal", "Normal");
    async function run(id: string) {
      const session = await manager.acquire(
        { agentName: "main", channelThreadKey: `webchat:${id}` },
        {
          workingDir: root,
          romeSessionId: id,
          sessionMetadata: { isolated: false },
          threadContext: {
            channel: "webchat",
            threadId: id,
            romeSessionId: id,
            threadPath: join(root, ".threads", id),
            channelUserId: "guardian",
            threadType: "private",
            projectName: "SECRET-SELECTED-PROJECT",
            projectPath: root,
          },
        },
      );
      const handle = session.sendTurn({ prompt: "task only" });
      for await (const _event of handle.events) {
        // Turns own their stream until the terminal event.
      }
      await session.close("idle");
    }
    await run("normal");
    await run("isolated");
    await repo.updateSessionName("isolated", "Renamed executor");
    await run("isolated");
    const normal = model.sessions[0].systemPrompt;
    for (const secret of ["SECRET-MEMORY", "SECRET-IDENTITY", "SECRET-PROJECT", "SECRET-APP"]) {
      expect(normal).toContain(secret);
      expect(model.sessions[1].systemPrompt).not.toContain(secret);
      expect(model.sessions[2].systemPrompt).not.toContain(secret);
    }
    expect(model.sessions[1].systemPrompt).toContain("Keep safety instructions");
    expect(model.sessions[1].systemPrompt).toContain("Notes stay available");
    expect(model.calls[0].prompt).toContain("SECRET-SELECTED-PROJECT");
    expect(model.calls[1].prompt).not.toContain("SECRET-SELECTED-PROJECT");
    expect(model.calls[1].prompt).toContain("channel: webchat");
    expect(JSON.parse((await repo.getSession("isolated"))!.metadataJson)).toEqual(metadata);
  });
});

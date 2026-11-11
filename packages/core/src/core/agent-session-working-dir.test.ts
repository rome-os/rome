import { romeToolPorts } from "./rome-tool-ports.js";
import { ChatSessionSettings } from "../webchat/chat-session-settings.js";
import { createLogger } from "../logger.js";
import { readAnswerShape, romeSessionTracing } from "../agent/index.js";
import { TurnUsageReporter } from "../app-host/turn-usage-reporter.js";
import { agentFolders } from "../paths.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/db.js";
import { AgentLoader } from "../app-host/agent-loader.js";
import { TurnListeners } from "../agent/index.js";
import { AppTurnHooks } from "../app-host/app-turn-hooks.js";
import { createSessionFromRun, type ModelProvider } from "./agent-runner.js";
import {
  createSessions,
  type SessionOpening,
  type AgentSessionKey,
  type Sessions,
} from "../agent/index.js";
import { eq } from "drizzle-orm";
import { createModelResolver } from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { DrizzleSessionRepository, Session, type SessionRepository } from "../agent/index.js";
import { SkillLoader } from "../app-host/skill-loader.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { reportOf, fakeAccounts } from "../test/kit/model-accounts.js";
import { openedInChat, openerChat } from "./session-conversation.js";
import { sessions } from "../db/schema.js";

const AGENT = "worker";

describe("Sessions working dirs", () => {
  let directory: string;
  let testDb: TestDb;
  let manager: Sessions;
  let sessionRepository: SessionRepository;
  let webchatRepo: WebChatRepository;
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
    const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    const loader = new AgentLoader(artifactIdentity);
    await loader.loadAll(directory);
    testDb = createTestDb();
    sessionRepository = new DrizzleSessionRepository(testDb.db);
    webchatRepo = new ChatsWebChatRepository(testDb.db);
    const provider: ModelProvider = {
      id: "anthropic",
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
      openai: reportOf("unauthorized"),
      anthropic: reportOf("available"),
    };
    const actionRegistry = new ActionRegistryImpl();
    const systemPrompts = createTestSystemPrompts();
    rs.spyOn(systemPrompts, "build").mockReturnValue("Working dir test prompt");
    manager = createSessions(
      {
        agentLoader: loader,
        sessionRepository,
        sessionSettings: new ChatSessionSettings({ webchatRepo: webchatRepo }),
        systemPrompts,
        modelResolver: createModelResolver({
          providers: [provider],
          accounts: fakeAccounts(() => state),
        }),
        networkMcpServers: () => ({}),
        skillCatalog: new SkillLoader(artifactIdentity),
        turnLifecycle: new TurnListeners(new AppTurnHooks()),
        readAnswerShape,
        sessionTracing: romeSessionTracing,
        turnUsage: new TurnUsageReporter(),
        folders: agentFolders(),
        log: createLogger("agent-session"),
        ...romeToolPorts({
          webchatRepo,
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
    if (previousProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = previousProjectsRoot;
    rs.restoreAllMocks();
  });

  it("finds open sessions and the subagent sessions they own, and forgets closed ones", async () => {
    const parentDir = join(directory, "parent-project");
    const childDir = join(directory, "child-project");
    await mkdir(parentDir);
    await mkdir(childDir);

    const parent = await manager.open(
      { agentName: AGENT, channelThreadKey: "webchat:working-dir" },
      { workingDir: parentDir },
    );
    const childManager = (parent as unknown as { childManager: Sessions }).childManager;
    const child = await childManager.open(
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
    const parent = await manager.open(
      { agentName: AGENT, channelThreadKey: "webchat:fork" },
      { workingDir: parentDir },
    );

    const fork = parent.fork!({ prompt: "side question" })[Symbol.asyncIterator]();
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
    const original = await manager.open(
      { agentName: AGENT, channelThreadKey: "action:resume" },
      { workingDir: projectDir },
    );
    const sessionId = original.sessionId;
    await original.close("idle");

    const resumed = await manager.resume({ id: sessionId, agent: AGENT });

    expect(resumed.sessionId).toBe(sessionId);
    expect(manager.findWorkingDirBySessionId!(sessionId)).toBe(projectDir);
  });

  it("reuses a session by channel-thread key in the working dir it was created in", async () => {
    const projectDir = join(directory, "site");
    await mkdir(projectDir);
    const key = { agentName: AGENT, channelThreadKey: "inbox:telegram:thread-1" };
    const original = await manager.open(key, { workingDir: projectDir });
    const sessionId = original.sessionId;
    await original.close("idle");

    const reused = await manager.open(key);

    expect(reused.sessionId).toBe(sessionId);
    expect(manager.findWorkingDirBySessionId!(sessionId)).toBe(projectDir);
  });

  it("refuses to resume a session whose recorded working dir is gone", async () => {
    const projectDir = join(directory, "renamed-later");
    await mkdir(projectDir);
    const original = await manager.open(
      { agentName: AGENT, channelThreadKey: "action:gone" },
      { workingDir: projectDir },
    );
    await original.close("idle");
    await rm(projectDir, { recursive: true });

    await expect(manager.resume({ id: original.sessionId, agent: AGENT })).rejects.toThrow(
      "which no longer exists",
    );
  });

  /** Acquires the way every opener does: the session, then the chat it names. */
  async function open(key: AgentSessionKey, chatId?: string, init: SessionOpening = {}) {
    const session = await manager.open(key, init);
    await openedInChat(webchatRepo, session, chatId);
    return session;
  }

  async function rowChat(sessionId: string): Promise<string | null | undefined> {
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.id, sessionId));
    return row?.chatId;
  }

  it("records the chat an opener names and keeps it in a fresh generation", async () => {
    const projectDir = join(directory, "moved-away");
    await mkdir(projectDir);
    await webchatRepo.createSession("conv-1", "Conversation");
    const key = { agentName: AGENT, channelThreadKey: "webchat:conv-1" };
    const original = await open(key, "conv-1", { workingDir: projectDir });
    await original.close("idle");
    expect(await rowChat(original.sessionId)).toBe("conv-1");

    await rm(projectDir, { recursive: true });
    const replacement = await open(key);

    expect(replacement.sessionId).not.toBe(original.sessionId);
    expect(await rowChat(replacement.sessionId)).toBe("conv-1");
    expect(await webchatRepo.chatOfSession(replacement.sessionId)).toMatchObject({ id: "conv-1" });
  });

  it("keeps a reuse or resume that names no chat in the chat the row recorded", async () => {
    await webchatRepo.createSession("stored", "Stored");
    const key = { agentName: AGENT, channelThreadKey: "webchat:stored" };
    const original = await open(key, "stored");
    const sessionId = original.sessionId;
    await original.close("idle");

    const byKey = await open(key);
    expect(byKey.sessionId).toBe(sessionId);
    await byKey.close("idle");

    const byId = await manager.resume({ id: sessionId, agent: AGENT });
    await openedInChat(webchatRepo, byId, undefined);
    expect(byId.sessionId).toBe(sessionId);
    expect(await webchatRepo.chatOfSession(sessionId)).toMatchObject({ id: "stored" });
  });

  it("finds a chat recorded after open by the session's id", async () => {
    const session = await open({
      agentName: AGENT,
      channelThreadKey: "webchat:late:subagent:1",
    });
    expect(await webchatRepo.chatOfSession(session.sessionId)).toBeNull();
    await webchatRepo.ensureRomeSession({
      id: session.sessionId,
      type: "subagent",
      name: "worker: Parent",
      agentName: AGENT,
    });

    await webchatRepo.recordSessionInChat(session.sessionId, session.sessionId);

    expect(await webchatRepo.chatOfSession(session.sessionId)).toMatchObject({
      id: session.sessionId,
      type: "subagent",
    });
  });

  it("finds the chat a session's row recorded, and skips one since deleted", async () => {
    await webchatRepo.ensureRomeSession({
      id: "channel:telegram:kept",
      type: "channel",
      name: "Telegram thread",
      agentName: null,
    });
    const kept = { agentName: AGENT, channelThreadKey: "telegram:kept" };
    const gone = { agentName: AGENT, channelThreadKey: "telegram:gone" };
    await (await open(kept, "channel:telegram:kept")).close("idle");
    await (await open(gone, "channel:telegram:gone")).close("idle");

    const reopened = await open(kept);
    const orphaned = await open(gone);

    expect(await webchatRepo.chatOfSession(reopened.sessionId)).toMatchObject({
      id: "channel:telegram:kept",
      type: "channel",
    });
    expect(await webchatRepo.chatOfSession(orphaned.sessionId)).toBeNull();
  });

  it("records the chat on a reused row that had none", async () => {
    const key = { agentName: AGENT, channelThreadKey: "webchat:legacy" };
    const original = await open(key);
    await original.close("idle");
    expect(await rowChat(original.sessionId)).toBeNull();

    const reused = await open(key, "legacy");

    expect(reused.sessionId).toBe(original.sessionId);
    expect(await rowChat(original.sessionId)).toBe("legacy");
  });

  it("remembers the chat an open session's opener named, and forgets it on reopen", async () => {
    const key = { agentName: AGENT, channelThreadKey: "webchat:opened" };
    const opened = await open(key, "opened");
    const reused = await open(key);

    expect(reused).toBe(opened);
    expect(openerChat(reused)).toBe("opened");

    await opened.close("idle");
    const reopened = await open(key);
    expect(reopened.sessionId).toBe(opened.sessionId);
    expect(openerChat(reopened)).toBeUndefined();
  });

  it("moves a reused row to the chat the caller names", async () => {
    const key = { agentName: AGENT, channelThreadKey: "webchat:kept" };
    const original = await open(key, "kept");
    await original.close("idle");

    const reused = await open(key, "other");

    expect(reused.sessionId).toBe(original.sessionId);
    expect(await rowChat(original.sessionId)).toBe("other");
  });

  it("records a chat learned after acquire", async () => {
    const child = await open({
      agentName: AGENT,
      channelThreadKey: "main:subagent:1",
    });
    expect(await rowChat(child.sessionId)).toBeNull();

    await webchatRepo.recordSessionInChat(child.sessionId, child.sessionId);

    expect(await rowChat(child.sessionId)).toBe(child.sessionId);
  });

  it("fills a row with no chat when a resume names one", async () => {
    const original = await open({
      agentName: AGENT,
      channelThreadKey: "main:subagent:2",
    });
    await original.close("idle");

    const resumed = await manager.resume({ id: original.sessionId, agent: AGENT });
    await openedInChat(webchatRepo, resumed, original.sessionId);

    expect(await rowChat(original.sessionId)).toBe(original.sessionId);
  });

  it("records the dir a resume or a keyed reuse was moved to, once the provider opens", async () => {
    const firstDir = join(directory, "first");
    const secondDir = join(directory, "second");
    const thirdDir = join(directory, "third");
    await Promise.all([mkdir(firstDir), mkdir(secondDir), mkdir(thirdDir)]);
    const key = { agentName: AGENT, channelThreadKey: "webchat:moved" };
    const original = await manager.open(key, { workingDir: firstDir });
    const sessionId = original.sessionId;
    await original.close("idle");

    const byId = await manager.resume({ id: sessionId, agent: AGENT }, { workingDir: secondDir });
    await byId.close("idle");
    expect((await sessionRepository.session(sessionId))?.workingDir).toBe(secondDir);

    const byKey = await manager.open(key, { workingDir: thirdDir });
    await byKey.close("idle");
    expect((await sessionRepository.session(sessionId))?.workingDir).toBe(thirdDir);

    await manager.resume({ id: sessionId, agent: AGENT });
    expect(manager.findWorkingDirBySessionId!(sessionId)).toBe(thirdDir);
  });

  it("starts a fresh generation when a keyed reuse finds its recorded dir gone", async () => {
    const projectDir = join(directory, "deleted-later");
    await mkdir(projectDir);
    const key = { agentName: AGENT, channelThreadKey: "inbox:telegram:thread-2" };
    const original = await manager.open(key, { workingDir: projectDir });
    await original.close("idle");
    await rm(projectDir, { recursive: true });

    const fresh = await manager.open(key);

    expect(fresh.sessionId).not.toBe(original.sessionId);
    expect(manager.findWorkingDirBySessionId!(fresh.sessionId)).toBe(
      join(directory, "projects", "default"),
    );
    expect((await sessionRepository.session(original.sessionId))?.status).toBe("completed");
    expect((await sessionRepository.session(fresh.sessionId))?.workingDir).toBe(
      join(directory, "projects", "default"),
    );
  });

  it("resumes a legacy session with no recorded working dir in the default project", async () => {
    await sessionRepository.add(
      Session.create(`core:${AGENT}`, {
        deprecatedId: "legacy-session",
        continuityKey: "action:legacy",
      }),
    );

    await manager.resume({ id: "legacy-session", agent: AGENT });

    expect(manager.findWorkingDirBySessionId!("legacy-session")).toBe(
      join(directory, "projects", "default"),
    );
    expect((await sessionRepository.session("legacy-session"))?.workingDir).toBe(
      join(directory, "projects", "default"),
    );
  });

  it("refuses a session stored under one unknown agent when another unknown agent asks for it", async () => {
    await sessionRepository.add(
      Session.create("gone:writer", {
        deprecatedId: "orphan-session",
        continuityKey: "action:orphan",
      }),
    );

    await expect(manager.resume({ id: "orphan-session", agent: "gone:reader" })).rejects.toThrow(
      'Agent session "orphan-session" was not found or cannot be resumed',
    );
  });
});

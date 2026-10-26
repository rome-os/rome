import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import {
  createEmptyLegacyArtifactBindings,
  type ArtifactIdentityContext,
} from "../apps/artifact-id.js";
import { testChannelSurface } from "../test/channel-surface.js";
import { createActionEngineRepos, createTestDb, type TestDb } from "../test/helpers.js";
import type { AgentEvent } from "../types.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelRunParams,
  type ModelSessionParams,
  type ProviderId,
} from "./agent-runner.js";
import {
  createAgentSessionManager,
  type AgentSession,
  type AgentSessionManager,
} from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import type { ModelSelectionId } from "./model-selector.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";
import type { ThreadContext } from "./types.js";

const AGENT = "continuation_agent";
const CHAT = "chat-continuation";
const key = { agentName: AGENT, channelThreadKey: `webchat:${CHAT}` };
const threadContext: ThreadContext = {
  channel: "webchat",
  threadId: CHAT,
  romeSessionId: CHAT,
  threadType: "private",
};
const START = Date.parse("2026-10-26T00:00:00Z");

function createProvider(id: ProviderId) {
  const calls: ModelRunParams[] = [];
  const opened: ModelSessionParams[] = [];
  const openSession = rs.fn(async (params: ModelSessionParams) => {
    opened.push(params);
    const session = createSessionFromRun(
      id,
      async function* (input): AsyncIterable<AgentEvent> {
        calls.push(input);
        yield { type: "result", content: "done" };
      },
      params,
    );
    session.providerThreadId = params.providerThreadId ?? `${id}-thread-${opened.length}`;
    return session;
  });
  const provider: ModelProvider = {
    id,
    displayName: id,
    builtinTools: new Set<string>(),
    openSession,
  };
  return { provider, openSession, calls, opened };
}

function healthyState() {
  return {
    codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
    claude: { loggedIn: true, quotaExhausted: false },
  };
}

function continuationOf(prompt: string | undefined): string | null {
  return prompt?.match(/<continuation[\s\S]*?<\/continuation>/)?.[0] ?? null;
}

describe("continuation notice through AgentSessionManager", () => {
  let directory: string;
  let testDb: TestDb;
  let loader: AgentLoader;
  let sessionManager: SessionManager;
  let sessionsRepo: SessionsRepository;
  let webchatRepo: WebChatRepository;
  let openai: ReturnType<typeof createProvider>;
  let anthropic: ReturnType<typeof createProvider>;
  let artifactIdentity: ArtifactIdentityContext;
  let now: number;
  const managers: AgentSessionManager[] = [];

  function at(seconds: number) {
    now = START + seconds * 1000;
    rs.setSystemTime(new Date(now));
  }

  function createManager(): AgentSessionManager {
    const actionRegistry = new ActionRegistryImpl();
    actionRegistry.register({
      config: {
        name: "system:fetch_channel_history",
        description: "Read a chat's history",
      },
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ status: "ok", data: {} }),
    } as never);
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("Continuation test prompt");
    const state = healthyState();
    const manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager,
        sessionsRepo,
        webchatRepo,
        promptBuilder,
        actionRegistry,
        actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
        modelResolver: createModelResolver({
          providers: [openai.provider, anthropic.provider],
          aiToolState: { get: () => state, refresh: async () => state },
          romeCreditsPayer: { isUsingRomeCredits: () => false },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(artifactIdentity),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
        channelSurface: testChannelSurface,
      },
      { keepAliveAcrossTurns: true },
    );
    managers.push(manager);
    return manager;
  }

  function acquire(manager: AgentSessionManager, selectionId?: ModelSelectionId | null) {
    return manager.acquire(key, {
      workingDir: directory,
      threadContext,
      romeSessionId: CHAT,
      ...(selectionId !== undefined ? { selectionId } : {}),
    });
  }

  /** One chat turn the way webchat runs it: the input row first, the reply
   *  row after the turn has ended. */
  async function chatTurn(session: AgentSession, text: string): Promise<void> {
    const inputId = randomUUID();
    await webchatRepo.recordUserInput(
      inputId,
      CHAT,
      JSON.stringify([{ type: "text", content: text }]),
    );
    at((now - START) / 1000 + 1);
    const handle = session.sendTurn(
      { prompt: text, inputId },
      { threadContext, romeSessionId: CHAT, romeSessionType: "webchat" },
    );
    for await (const _event of handle.events) {
      // drain
    }
    at((now - START) / 1000 + 1);
    await webchatRepo.addMessage(
      randomUUID(),
      CHAT,
      "assistant",
      JSON.stringify([{ type: "text", content: `reply to ${text}` }]),
      handle.turnId,
    );
  }

  beforeEach(async () => {
    rs.useFakeTimers({ toFake: ["Date"] });
    at(0);
    directory = await mkdtemp(join(tmpdir(), "rome-continuation-"));
    testDb = createTestDb();
    artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    loader = new AgentLoader(artifactIdentity);
    sessionsRepo = new SessionsRepository(testDb.db);
    sessionManager = new SessionManager(sessionsRepo, artifactIdentity);
    webchatRepo = new WebChatRepository(testDb.db);
    await webchatRepo.createSession(CHAT, "Continuation");
    openai = createProvider("openai");
    anthropic = createProvider("anthropic");
    await writeFile(
      join(directory, `${AGENT}.yaml`),
      JSON.stringify({
        name: AGENT,
        description: "Continuation fixture",
        tier: "large",
        systemPromptPrefix: "Answer.",
        tools: [],
        actions: ["system:fetch_channel_history"],
        permissionMode: "default",
      }),
    );
    await loader.loadAll(directory);
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    testDb?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    rs.useRealTimers();
    rs.restoreAllMocks();
  });

  it("moves an open chat to another provider and names what the new thread has not seen, once", async () => {
    const manager = createManager();
    const session = await acquire(manager, "claude-sonnet");
    await chatTurn(session, "Should I get a pet? A cat, but I worry about allergies.");
    await chatTurn(session, "My locker code is 4417.");
    expect(continuationOf(anthropic.calls[1]?.prompt)).toBeNull();

    // The guardian picks a Codex model in the open chat: the same live session
    // takes it from its next turn.
    expect(await acquire(manager, "gpt-6-luna")).toBe(session);
    await chatTurn(session, "Which animal was it, and what was my worry?");

    expect(openai.calls.map((call) => call.model)).toEqual(["gpt-6-luna"]);
    expect(openai.opened[0]?.providerThreadId).toBeUndefined();
    const prompt = openai.calls[0]?.prompt ?? "";
    const notice = continuationOf(prompt);
    expect(notice).toContain('unseen_messages="4"');
    expect(notice).toContain('previous_model="claude-sonnet-5-5"');
    expect(notice).toContain("system:fetch_channel_history");
    // The thread context names the channel; the notice does not repeat it.
    expect(notice).not.toContain("webchat");
    expect(prompt).toContain("<thread_context>");
    expect(prompt.indexOf("<thread_context>")).toBeLessThan(prompt.indexOf("<continuation"));

    await chatTurn(session, "Thanks.");
    expect(continuationOf(openai.calls[1]?.prompt)).toBeNull();
    expect(openai.calls[1]?.prompt).not.toContain("<thread_context>");
    expect(await sessionsRepo.findById(session.sessionId)).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
    });
  });

  it("continues the same provider's thread on another model without a notice", async () => {
    const manager = createManager();
    const session = await acquire(manager, "claude-sonnet");
    await chatTurn(session, "first");
    await acquire(manager, "claude-opus-5-5");
    await chatTurn(session, "second");

    expect(anthropic.calls.map((call) => call.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5-5[1m]",
    ]);
    expect(anthropic.opened.map((params) => params.providerThreadId)).toEqual([
      undefined,
      "anthropic-thread-1",
    ]);
    expect(continuationOf(anthropic.calls[1]?.prompt)).toBeNull();
    expect(await sessionsRepo.findById(session.sessionId)).toMatchObject({
      model: "claude-opus-5-5[1m]",
    });
  });

  it("names chat messages the thread did not take part in", async () => {
    const manager = createManager();
    const session = await acquire(manager, "claude-sonnet");
    await chatTurn(session, "first");
    at(30);
    // A routine posted into the chat while no turn ran.
    await webchatRepo.addMessage(
      randomUUID(),
      CHAT,
      "assistant",
      JSON.stringify([{ type: "text", content: "Your 9am meeting moved." }]),
    );
    at(40);
    await chatTurn(session, "second");
    const notice = continuationOf(anthropic.calls[1]?.prompt);
    expect(notice).toContain('unseen_messages="1"');
    expect(notice).not.toContain("previous_model");
  });

  it("names the earlier chat when a cold open lands on another provider", async () => {
    const first = createManager();
    const session = await acquire(first, "claude-sonnet");
    await chatTurn(session, "first");
    await first.shutdown();

    const resumed = await acquire(createManager(), "gpt-6-luna");
    expect(resumed.sessionId).toBe(session.sessionId);
    await chatTurn(resumed, "second");
    const notice = continuationOf(openai.calls[0]?.prompt);
    expect(notice).toContain('unseen_messages="2"');
    expect(notice).toContain('previous_model="claude-sonnet-5-5"');
    expect(openai.calls[0]?.prompt).toContain("<thread_context>");
  });

  it("resumes its own thread on a cold open without a notice", async () => {
    const first = createManager();
    const session = await acquire(first, "claude-sonnet");
    await chatTurn(session, "first");
    await first.shutdown();

    const resumed = await acquire(createManager(), "claude-sonnet");
    await chatTurn(resumed, "second");
    expect(anthropic.opened[1]?.providerThreadId).toBe("anthropic-thread-1");
    expect(continuationOf(anthropic.calls[1]?.prompt)).toBeNull();
    expect(anthropic.calls[1]?.prompt).not.toContain("<thread_context>");
  });

  it("treats a resumed row written before seen marks as having seen the chat", async () => {
    const first = createManager();
    const session = await acquire(first, "claude-sonnet");
    await chatTurn(session, "first");
    await first.shutdown();
    await sessionsRepo.setSeenMark(session.sessionId, { threadId: null, turnId: null, at: null });

    const resumed = await acquire(createManager(), "claude-sonnet");
    await chatTurn(resumed, "second");
    expect(continuationOf(anthropic.calls[1]?.prompt)).toBeNull();
  });

  it("starts a reset generation without a notice, and a lost thread with one", async () => {
    const first = createManager();
    const session = await acquire(first, "claude-sonnet");
    await chatTurn(session, "first");
    await first.shutdown();

    at(60);
    await sessionsRepo.rotateProviderGeneration({
      agentName: AGENT,
      channelThreadKey: key.channelThreadKey,
      newSessionId: randomUUID(),
      chatId: CHAT,
      seenAt: new Date(now),
    });
    const reset = createManager();
    await chatTurn(await acquire(reset, "claude-sonnet"), "after reset");
    expect(continuationOf(anthropic.calls[1]?.prompt)).toBeNull();
    await reset.shutdown();

    await sessionsRepo.rotateProviderGeneration({
      agentName: AGENT,
      channelThreadKey: key.channelThreadKey,
      newSessionId: randomUUID(),
      chatId: CHAT,
    });
    await chatTurn(await acquire(createManager(), "claude-sonnet"), "after loss");
    expect(continuationOf(anthropic.calls[2]?.prompt)).toContain('unseen_messages="4"');
  });

  it("clears an open chat's selection with null and keeps it with undefined", async () => {
    const manager = createManager();
    const session = await acquire(manager, "claude-sonnet");
    await chatTurn(session, "first");
    await acquire(manager);
    await chatTurn(session, "second");
    await acquire(manager, "gpt-6-luna");
    await acquire(manager, null);
    await chatTurn(session, "third");

    // Null hands the session back to its pin, the model its last turn ran on.
    expect(anthropic.calls.map((call) => call.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(openai.calls).toHaveLength(0);
  });
});

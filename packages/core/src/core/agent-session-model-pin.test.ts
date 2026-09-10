import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { AgentMessage } from "../types.js";
import { AgentLoader } from "./agent-loader.js";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelRunParams,
  type ModelSessionParams,
  type ProviderId,
} from "./agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "./agent-session.js";
import { CapabilityDiscovery } from "./capability-discovery.js";
import { createModelResolver } from "./model-resolver.js";
import { PromptBuilder } from "./prompt-builder.js";
import { SessionManager } from "./session-manager.js";
import { SkillCatalog } from "./skill-catalog.js";

const AGENT = "pinned_agent";
const MODEL = "gpt-5.3-codex-spark";
const baseConfig = {
  name: AGENT,
  description: "Model pin regression fixture",
  provider: "openai",
  modelId: MODEL,
  systemPromptPrefix: "Complete the task.",
  tools: [],
  permissionMode: "default",
};
const key = { agentName: AGENT, channelThreadKey: "webchat:model-pin-test" };

function createProvider(id: ProviderId) {
  const calls: ModelRunParams[] = [];
  const openSession = rs.fn(async (params: ModelSessionParams) =>
    createSessionFromRun(
      id,
      async function* (input): AsyncIterable<AgentMessage> {
        calls.push(input);
        yield { type: "result", content: "done" };
      },
      { ...params, providerThreadId: params.providerThreadId ?? `native-${params.sessionId}` },
    ),
  );
  const provider: ModelProvider = {
    id,
    displayName: id,
    builtinTools: new Set<string>(),
    openSession,
  };
  return { provider, openSession, calls };
}

function healthyState() {
  return {
    codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
    claude: { loggedIn: true, quotaExhausted: false },
  };
}

async function collect(events: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const message of events) messages.push(message);
  return messages;
}

describe("agent model pins through AgentSessionManager", () => {
  let directory: string;
  let testDb: TestDb;
  let loader: AgentLoader;
  let sessionManager: SessionManager;
  let openai: ReturnType<typeof createProvider>;
  let anthropic: ReturnType<typeof createProvider>;
  let state: ReturnType<typeof healthyState>;
  const managers: AgentSessionManager[] = [];

  async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
    const config = { ...baseConfig, ...overrides };
    // JSON is valid YAML. Keeping the serializer here avoids quoting model IDs by hand.
    await writeFile(join(directory, `${config.name}.yaml`), JSON.stringify(config));
    await loader.loadAll(directory);
  }

  function createManager(isSubagent = false): AgentSessionManager {
    const actionRegistry = new ActionRegistryImpl([]);
    const promptBuilder = new PromptBuilder();
    rs.spyOn(promptBuilder, "build").mockReturnValue("Model pin test prompt");
    const manager = createAgentSessionManager(
      {
        agentLoader: loader,
        sessionManager,
        promptBuilder,
        actionRegistry,
        actionEngine: new ActionEngine(actionRegistry),
        modelResolver: createModelResolver({
          providers: [openai.provider, anthropic.provider],
          aiToolState: { get: () => state, refresh: async () => state },
        }),
        capabilityDiscovery: new CapabilityDiscovery(),
        skillCatalog: new SkillCatalog(),
        lifecycleDispatcher: createAgentLifecycleDispatcher(),
      },
      { keepAliveAcrossTurns: true, isSubagent },
    );
    managers.push(manager);
    return manager;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-model-pin-"));
    testDb = createTestDb();
    loader = new AgentLoader();
    sessionManager = new SessionManager(new SessionsRepository(testDb.db));
    openai = createProvider("openai");
    anthropic = createProvider("anthropic");
    state = healthyState();
    await writeConfig();
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    testDb?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    rs.restoreAllMocks();
  });

  it("loads a no-tier YAML pin and uses it on the first and later turns", async () => {
    expect(loader.get(AGENT)).toMatchObject({ providerId: "openai", modelId: MODEL });
    expect(loader.get(AGENT).tier).toBeUndefined();
    const session = await createManager().acquire(key, { workingDir: directory });
    await collect(session.sendTurn({ prompt: "first" }).events);
    await collect(session.sendTurn({ prompt: "second" }).events);

    expect(openai.openSession).toHaveBeenCalledTimes(1);
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, MODEL]);
    expect(anthropic.openSession).not.toHaveBeenCalled();
    expect(await sessionManager.findResumableSessionById(session.sessionId, AGENT)).toMatchObject({
      provider: "openai",
      model: MODEL,
      providerThreadId: `native-${session.sessionId}`,
    });
  });

  it("resumes the saved pin after a manifest change, but uses the new pin for a new session", async () => {
    const firstManager = createManager();
    const first = await firstManager.acquire(key, { workingDir: directory });
    await collect(first.sendTurn({ prompt: "establish pin" }).events);
    await firstManager.shutdown();

    await writeConfig({ provider: "anthropic", modelId: "future-model[1m]" });
    const secondManager = createManager();
    const resumed = await secondManager.acquire(key, { workingDir: directory });
    expect(resumed.sessionId).toBe(first.sessionId);
    await collect(resumed.sendTurn({ prompt: "resume" }).events);
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, MODEL]);
    expect(anthropic.openSession).not.toHaveBeenCalled();

    const fresh = await secondManager.acquire(
      { ...key, channelThreadKey: "webchat:new-model-pin-test" },
      { workingDir: directory },
    );
    await collect(fresh.sendTurn({ prompt: "new conversation" }).events);
    expect(anthropic.calls.map((call) => call.model)).toEqual(["future-model[1m]"]);
  });

  it("allows a guardian override without a tier and persists the override on cold resume", async () => {
    const firstManager = createManager();
    const first = await firstManager.acquire(key, {
      workingDir: directory,
      selectionId: "claude-sonnet",
    });
    await collect(first.sendTurn({ prompt: "use selected model" }).events);
    await firstManager.shutdown();

    const resumed = await createManager().acquire(key, {
      workingDir: directory,
      resumeSessionId: first.sessionId,
    });
    await collect(resumed.sendTurn({ prompt: "continue" }).events);
    expect(anthropic.calls.map((call) => call.model)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-5",
    ]);
    expect(openai.openSession).not.toHaveBeenCalled();
  });

  it("fails closed on a disconnected pinned provider even when another provider is healthy", async () => {
    state.codex.loggedIn = false;
    await expect(createManager().acquire(key, { workingDir: directory })).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
    expect(openai.openSession).not.toHaveBeenCalled();
    expect(anthropic.openSession).not.toHaveBeenCalled();
  });

  it("fails a later turn on quota exhaustion and recovers on the same model", async () => {
    const session = await createManager().acquire(key, { workingDir: directory });
    await collect(session.sendTurn({ prompt: "first" }).events);
    state.codex.quotaExhausted = true;
    const failed = await collect(session.sendTurn({ prompt: "blocked" }).events);
    expect(failed).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "model_provider_unavailable",
        provider: "openai",
        reason: "quota_exhausted",
      }),
    );
    expect(openai.calls).toHaveLength(1);
    expect(anthropic.openSession).not.toHaveBeenCalled();

    state.codex.quotaExhausted = false;
    await collect(session.sendTurn({ prompt: "retry" }).events);
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, MODEL]);
  });

  it("enforces known model entitlements instead of substituting a tier model", async () => {
    await writeConfig({ modelId: "gpt-6-astra" });
    state.codex.solAccess = false;
    await expect(createManager().acquire(key, { workingDir: directory })).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    expect(openai.openSession).not.toHaveBeenCalled();
    expect(anthropic.openSession).not.toHaveBeenCalled();
  });

  it("keeps a child's tier selection independent of a parent's pin on a shared thread", async () => {
    const parent = await createManager().acquire(key, { workingDir: directory });
    await collect(parent.sendTurn({ prompt: "parent" }).events);
    await writeConfig({ name: "worker", modelId: undefined, tier: "medium" });
    const child = await createManager(true).acquire(
      { ...key, agentName: "worker" },
      { workingDir: directory },
    );
    await collect(child.sendTurn({ prompt: "child" }).events);
    expect(child.sessionId).not.toBe(parent.sessionId);
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, "gpt-5.6-terra"]);
  });
});

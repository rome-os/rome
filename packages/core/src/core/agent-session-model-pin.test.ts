import { romeToolPorts } from "./rome-tool-ports.js";
import { createLogger } from "../logger.js";
import { readAnswerShape, romeSessionTracing } from "../agent/index.js";
import { TurnUsageReporter } from "../apps/turn-usage-reporter.js";
import { agentFolders } from "../paths.js";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { createTestDb, type TestDb, createActionEngineRepos } from "../test/db.js";
import type { AgentEvent } from "../types.js";
import { AgentLoader } from "../apps/agent-loader.js";
import {
  TurnListeners,
  type AgentTurnFailedBeforeStart,
  type TurnLifecycle,
} from "../agent/index.js";
import { AppTurnHooks } from "../apps/app-turn-hooks.js";
import {
  createSessionFromRun,
  type ModelProvider,
  type ModelRunParams,
  type ModelSessionParams,
  type ProviderId,
} from "./agent-runner.js";
import { createSessions, type Sessions } from "../agent/index.js";
import { createModelResolver } from "../agent/index.js";
import { createTestSystemPrompts } from "../test/system-prompts.js";
import { DrizzleSessionRepository, type SessionRepository } from "../agent/index.js";
import { SkillLoader } from "../apps/skill-loader.js";
import {
  createEmptyLegacyArtifactBindings,
  type ArtifactIdentityContext,
} from "../apps/artifact-id.js";
import { reportOf, fakeAccounts, loginsOn, RESTRICTED_PLAN } from "../test/kit/model-accounts.js";
import { startAfter } from "../test/turn-handle.js";

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
  const openSession = rs.fn(async (params: ModelSessionParams) => {
    const session = createSessionFromRun(
      id,
      async function* (input): AsyncIterable<AgentEvent> {
        calls.push(input);
        yield { type: "result", content: "done" };
      },
      params,
    );
    return {
      ...session,
      modelThreadId: params.thread.kind === "resume" ? params.thread.modelThreadId : `native-${id}`,
    };
  });
  const provider: ModelProvider = {
    id,
    builtinTools: new Set<string>(),
    openSession,
  };
  return { provider, openSession, calls };
}

function healthyState() {
  return {
    openai: reportOf("available"),
    anthropic: reportOf("available"),
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const messages: AgentEvent[] = [];
  for await (const message of events) messages.push(message);
  return messages;
}

describe("agent model pins through Sessions", () => {
  let directory: string;
  let testDb: TestDb;
  let loader: AgentLoader;
  let sessionRepository: SessionRepository;
  let openai: ReturnType<typeof createProvider>;
  let anthropic: ReturnType<typeof createProvider>;
  let state: ReturnType<typeof healthyState>;
  const managers: Sessions[] = [];
  let artifactIdentity: ArtifactIdentityContext;

  async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
    const config = { ...baseConfig, ...overrides };
    // JSON is valid YAML. Keeping the serializer here avoids quoting model IDs by hand.
    await writeFile(join(directory, `${config.name}.yaml`), JSON.stringify(config));
    await loader.loadAll(directory);
  }

  function createManager(
    isSubagent = false,
    useRomeCredits: boolean | (() => boolean) = false,
    turnLifecycle: TurnLifecycle = new TurnListeners(new AppTurnHooks()),
  ): Sessions {
    const actionRegistry = new ActionRegistryImpl();
    const systemPrompts = createTestSystemPrompts();
    rs.spyOn(systemPrompts, "build").mockReturnValue("Model pin test prompt");
    const manager = createSessions(
      {
        agentLoader: loader,
        sessionRepository,
        systemPrompts,
        modelResolver: createModelResolver({
          providers: [openai.provider, anthropic.provider],
          accounts: fakeAccounts(() => state),
          codexLogins: {
            login: () =>
              loginsOn(
                typeof useRomeCredits === "function" ? useRomeCredits() : useRomeCredits,
              ).login(),
          },
        }),
        networkMcpServers: () => ({}),
        skillCatalog: new SkillLoader(artifactIdentity),
        turnLifecycle,
        readAnswerShape,
        sessionTracing: romeSessionTracing,
        turnUsage: new TurnUsageReporter(),
        folders: agentFolders(),
        log: createLogger("agent-session"),
        ...romeToolPorts({
          actionRegistry,
          actionEngine: new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db)),
        }),
      },
      { keepAliveAcrossTurns: true, isSubagent },
    );
    managers.push(manager);
    return manager;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rome-agent-model-pin-"));
    testDb = createTestDb();
    artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
    loader = new AgentLoader(artifactIdentity);
    sessionRepository = new DrizzleSessionRepository(testDb.db, artifactIdentity);
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
    expect(loader.find(AGENT)?.definition).toMatchObject({ providerId: "openai", modelId: MODEL });
    expect(loader.find(AGENT)?.definition.tier).toBeUndefined();
    const session = await createManager().open(key, { workingDir: directory });
    await collect((await startAfter(session, { prompt: "first" })).events());
    await collect((await startAfter(session, { prompt: "second" })).events());

    expect(openai.openSession).toHaveBeenCalledTimes(1);
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, MODEL]);
    expect(anthropic.openSession).not.toHaveBeenCalled();
    expect(await sessionRepository.session(session.sessionId)).toMatchObject({
      provider: "openai",
      model: MODEL,
      modelThreadId: "native-openai",
    });
  });

  it("pins a credit-funded session to the model ChatGPT would run", async () => {
    await writeConfig({ provider: undefined, modelId: undefined, tier: "large" });
    // No account authorized: Rome credits are the login, and serve the frontier models.
    state.openai = reportOf("unauthorized");
    state.anthropic = reportOf("unauthorized");
    let usingRomeCredits = true;
    const session = await createManager(false, () => usingRomeCredits).open(key, {
      workingDir: directory,
    });
    await collect((await startAfter(session, { prompt: "credits" })).events());
    expect(await sessionRepository.session(session.sessionId)).toMatchObject({
      provider: "openai",
      model: "gpt-6.1-sol",
    });

    // Connecting ChatGPT changes only the login: the pinned model keeps running.
    state.openai = reportOf("available");
    usingRomeCredits = false;
    await collect((await startAfter(session, { prompt: "guardian" })).events());

    expect(openai.calls.map((call) => call.model)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
    expect(openai.openSession).toHaveBeenCalledTimes(1);
  });

  it("keeps a pinned Codex session running on credits after ChatGPT disconnects", async () => {
    await writeConfig({ provider: undefined, modelId: undefined, tier: "small" });
    const firstManager = createManager();
    const first = await firstManager.open(key, { workingDir: directory });
    await collect((await startAfter(first, { prompt: "guardian" })).events());
    await firstManager.shutdown();

    state.openai = reportOf("unauthorized");
    const resumed = await createManager(false, true).open(key, { workingDir: directory });
    await collect((await startAfter(resumed, { prompt: "credits" })).events());

    expect(openai.calls.map((call) => call.model)).toEqual(["gpt-6-luna", "gpt-6-luna"]);
  });

  it("resumes the saved pin after a manifest change, but uses the new pin for a new session", async () => {
    const firstManager = createManager();
    const first = await firstManager.open(key, { workingDir: directory });
    await collect((await startAfter(first, { prompt: "establish pin" })).events());
    await firstManager.shutdown();

    await writeConfig({ provider: "anthropic", modelId: "future-model[1m]" });
    const secondManager = createManager();
    const resumed = await secondManager.open(key, { workingDir: directory });
    expect(resumed.sessionId).toBe(first.sessionId);
    await collect((await startAfter(resumed, { prompt: "resume" })).events());
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, MODEL]);
    expect(anthropic.openSession).not.toHaveBeenCalled();

    const fresh = await secondManager.open(
      { ...key, channelThreadKey: "webchat:new-model-pin-test" },
      { workingDir: directory },
    );
    await collect((await startAfter(fresh, { prompt: "new conversation" })).events());
    expect(anthropic.calls.map((call) => call.model)).toEqual(["future-model[1m]"]);
  });

  it("allows a guardian override without a tier and persists the override on cold resume", async () => {
    const firstManager = createManager();
    const first = await firstManager.open(key, {
      workingDir: directory,
      selectionId: "claude-sonnet",
    });
    await collect((await startAfter(first, { prompt: "use selected model" })).events());
    await firstManager.shutdown();

    const resumed = await createManager().resume(
      { id: first.sessionId, agent: key.agentName },
      { workingDir: directory },
    );
    await collect((await startAfter(resumed, { prompt: "continue" })).events());
    expect(anthropic.calls.map((call) => call.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(openai.openSession).not.toHaveBeenCalled();
  });

  it("fails closed on a disconnected pinned provider even when another provider is healthy", async () => {
    state.openai = reportOf("unauthorized");
    await expect(createManager().open(key, { workingDir: directory })).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
    expect(openai.openSession).not.toHaveBeenCalled();
    expect(anthropic.openSession).not.toHaveBeenCalled();
  });

  it("fails a later turn on quota exhaustion and recovers on the same model", async () => {
    const session = await createManager().open(key, { workingDir: directory });
    await collect((await startAfter(session, { prompt: "first" })).events());
    state.openai = reportOf("usage_limit_reached");
    const failed = await collect((await startAfter(session, { prompt: "blocked" })).events());
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

    state.openai = reportOf("available");
    await collect((await startAfter(session, { prompt: "retry" })).events());
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, MODEL]);
  });

  it("tells in-process listeners once of a later turn that fails before it starts", async () => {
    const lifecycle = new TurnListeners(new AppTurnHooks());
    const finished: string[] = [];
    const failedBeforeStart: AgentTurnFailedBeforeStart[] = [];
    lifecycle.listen({
      ended: (event) => finished.push(event.turn.turnId),
      couldNotStart: (event) => failedBeforeStart.push(event),
    });
    const session = await createManager(false, false, lifecycle).open(key, {
      workingDir: directory,
    });
    const first = await startAfter(session, { prompt: "first" });
    await collect(first.events());
    state.openai = reportOf("usage_limit_reached");
    const blocked = await startAfter(session, { prompt: "blocked" });
    await collect(blocked.events());

    expect(finished).toEqual([first.id]);
    expect(failedBeforeStart).toEqual([
      {
        turn: expect.objectContaining({ turnId: blocked.id }),
        error: expect.stringContaining("Selected model provider is unavailable"),
      },
    ]);
  });

  it("enforces known model entitlements instead of substituting a tier model", async () => {
    await writeConfig({ modelId: "gpt-6-astra" });
    state.openai = reportOf("available", RESTRICTED_PLAN);
    await expect(createManager().open(key, { workingDir: directory })).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    expect(openai.openSession).not.toHaveBeenCalled();
    expect(anthropic.openSession).not.toHaveBeenCalled();
  });

  it("keeps a child's tier selection independent of a parent's pin on a shared thread", async () => {
    const parent = await createManager().open(key, { workingDir: directory });
    await collect((await startAfter(parent, { prompt: "parent" })).events());
    await writeConfig({ name: "worker", modelId: undefined, tier: "medium" });
    const child = await createManager(true).open(
      { ...key, agentName: "worker" },
      { workingDir: directory },
    );
    await collect((await startAfter(child, { prompt: "child" })).events());
    expect(child.sessionId).not.toBe(parent.sessionId);
    expect(openai.calls.map((call) => call.model)).toEqual([MODEL, "gpt-6.1-sol"]);
  });
});

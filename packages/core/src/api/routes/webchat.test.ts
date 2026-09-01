import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context as otelContext } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createWebchatRuntime } from "./webchat.js";
import { AgentInputQueue } from "../../core/agent-input-queue.js";
import { runWithSessionActor } from "../../lib/session-actor.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import type {
  AgentSession,
  AgentSessionInit,
  AgentTurnHandle,
  AgentTurnInput,
  SendTurnOptions,
} from "../../core/agent-session.js";
import type { ForkRunParams } from "../../core/types.js";
import { ModelResolutionError } from "../../core/model-resolver.js";
import { webchatProjects } from "../../db/schema.js";
import { TURN_BRANCH_PROMPT_MAX_LENGTH } from "@rome/api-types/trace-segments";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";

describe("Webchat API", () => {
  const originalProjectsRoot = process.env.ROME_PROJECTS_ROOT;
  let testDb: TestDb;
  let deps: TestDeps;
  let baseline: BaselineIds;
  let projectsRoot: string;

  beforeEach(async () => {
    projectsRoot = mkdtempSync(join(tmpdir(), "rome-webchat-route-"));
    process.env.ROME_PROJECTS_ROOT = projectsRoot;
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    baseline = await seedBaseline(testDb.db);
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
    rmSync(projectsRoot, { recursive: true, force: true });
    if (originalProjectsRoot === undefined) {
      delete process.env.ROME_PROJECTS_ROOT;
    } else {
      process.env.ROME_PROJECTS_ROOT = originalProjectsRoot;
    }
  });

  it("persists appended inputs once and keeps one stream owner", async () => {
    let finish!: () => void;
    const terminal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const steerUserInput = rs.fn().mockResolvedValue("accepted" as const);
    const start = rs.fn(
      (): AgentTurnHandle => ({
        turnId: "input-turn",
        turnContext: otelContext.active(),
        events: (async function* () {
          await terminal;
          yield { type: "result" as const, content: "" };
        })(),
      }),
    );
    const queue = new AgentInputQueue(
      start,
      () => ({ steerUserInput }),
      (error) => {
        throw error;
      },
    );
    const agent: AgentSession = {
      key: { agentName: "main", channelThreadKey: "webchat:test" },
      sessionId: "agent-session",
      status: "running",
      currentTurnId: "input-turn",
      sendTurn: start,
      submitInput: (input, options) => queue.submit(input, options),
      subscribe: () => () => {},
      onStatusChange: () => () => {},
      interrupt: async () => {},
      close: async () => {},
    };
    deps.agentSessionManager = {
      acquire: rs.fn(async () => agent),
      peek: () => agent,
      shutdown: async () => {},
    };
    const app = createWebchatRuntime(deps).routes;
    const created = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Inputs" }),
    });
    const { id } = (await created.json()) as { id: string };
    const post = (inputId: string, text: string) =>
      app.request(`/chat/sessions/${id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputId, text }),
      });
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    try {
      const firstSubmissions = await Promise.all([post(a, "first"), post(a, "first")]);
      expect(firstSubmissions.map((response) => response.status)).toEqual([200, 200]);
      expect(start).toHaveBeenCalledOnce();
      queue.ready("input-turn");
      expect(await (await post(b, "second")).json()).toMatchObject({
        inputId: b,
        turnId: "input-turn",
        disposition: "steering",
      });
      await rs.waitFor(() => expect(steerUserInput).toHaveBeenCalledOnce());
      await queue.observe({ type: "input_status", inputId: b, state: "consumed" }, "input-turn");
      expect((await post(b, "second")).status).toBe(200);
      expect(steerUserInput).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      const inputs = (await deps.webchatRepo.getMessages(id)).filter(
        (message) => message.role === "user",
      );
      expect(inputs).toHaveLength(2);
      expect(inputs.find((message) => message.id === b)).toMatchObject({
        inputState: "consumed",
        turnId: "input-turn",
      });
      expect(await (await app.request(`/chat/sessions/${id}/turns`)).json()).toHaveLength(1);
    } finally {
      finish();
    }
  });

  it("refuses a queued turn's Stop without interrupting the active turn", async () => {
    const finishers: (() => void)[] = [];
    let sequence = 0;
    const interrupt = rs.fn(async () => {});
    const agent: AgentSession = {
      key: { agentName: "main", channelThreadKey: "webchat:test" },
      sessionId: "agent-session",
      status: "running",
      currentTurnId: "stop-1",
      sendTurn: () => {
        const turnId = `stop-${++sequence}`;
        const terminal = new Promise<void>((resolve) => {
          finishers.push(resolve);
        });
        return {
          turnId,
          turnContext: otelContext.active(),
          events: (async function* () {
            await terminal;
            yield { type: "result" as const, content: "" };
          })(),
        };
      },
      subscribe: () => () => {},
      onStatusChange: () => () => {},
      interrupt,
      close: async () => {},
    };
    deps.agentSessionManager = {
      acquire: rs.fn(async () => agent),
      peek: () => agent,
      shutdown: async () => {},
    };
    const app = createWebchatRuntime(deps).routes;
    const created = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Stop" }),
    });
    const { id } = (await created.json()) as { id: string };
    try {
      for (const text of ["first", "second"])
        await app.request(`/chat/sessions/${id}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
      expect((await app.request("/chat/turns/stop-2/interrupt", { method: "POST" })).status).toBe(
        409,
      );
      expect(interrupt).not.toHaveBeenCalled();
      expect((await app.request("/chat/turns/stop-1/interrupt", { method: "POST" })).status).toBe(
        200,
      );
      expect(interrupt).toHaveBeenCalledWith("user-stop", "stop-1");
    } finally {
      for (const finish of finishers) finish();
    }
  });

  it("encodes scoped owner ids in agent picker icon URLs", async () => {
    const ownerId = "@foo/bar";
    deps.agentLoader = {
      getAllRecords: () =>
        new Map([
          [
            `${ownerId}:baz`,
            {
              config: {
                name: "baz",
                description: "Scoped agent",
              },
              metadata: {
                kind: "agent",
                ownerType: "app",
                ownerId,
                publicName: "baz",
                aliases: [],
                sourcePath: "/installed/%40foo%2Fbar/agents/baz.yaml",
              },
            },
          ],
        ]),
    } as unknown as typeof deps.agentLoader;
    deps.appCatalog = {
      listResolved: () => [
        {
          appId: ownerId,
          displayName: "Scoped app",
          iconAbsolutePath: "/installed/%40foo%2Fbar/icon.png",
          manifest: { description: "Scoped app description" },
        },
      ],
    } as unknown as typeof deps.appCatalog;

    const app = createWebchatRuntime(deps).routes;
    const res = await app.request("/chat/agents");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        ownerId,
        ownerType: "app",
        label: "Scoped app",
        description: "Scoped app description",
        iconUrl: "/api/apps/%40foo%2Fbar/icon",
        agents: [{ name: `${ownerId}:baz`, localName: "baz", description: "Scoped agent" }],
      },
    ]);
  });

  it("aggregates completed child trace summaries without duplicating them in storage", async () => {
    const parentSessionId = "parent-summary-session";
    const parentTurnId = "parent-summary-turn";
    const childSessionId = "child-summary-session";
    const childTurnId = "child-summary-turn";
    const secondChildSessionId = "second-child-summary-session";
    const secondChildTurnId = "second-child-summary-turn";
    await deps.webchatRepo.createSession(parentSessionId, "Parent summary");
    await deps.webchatRepo.ensureRomeSession({
      id: childSessionId,
      type: "subagent",
      name: "planning child",
      agentName: "planning",
      parentSessionId,
      parentTurnId,
    });
    await deps.webchatRepo.ensureRomeSession({
      id: secondChildSessionId,
      type: "subagent",
      name: "research child",
      agentName: "research",
      parentSessionId,
      parentTurnId,
    });
    await deps.webchatRepo.addMessage(
      "child-summary-trace",
      childSessionId,
      "trace",
      JSON.stringify([
        {
          type: "tool_use",
          tool: "Read",
          input: {},
          id: "child-read",
          startedAt: "2026-07-14T00:00:00.000Z",
        },
        {
          type: "tool_result",
          tool: "Read",
          output: "done",
          toolUseId: "child-read",
          endedAt: "2026-07-14T00:00:01.000Z",
        },
        { type: "turn_end", turnId: childTurnId, status: "completed", durationMs: 1000 },
      ]),
      childTurnId,
    );
    await deps.webchatRepo.addMessage(
      "second-child-summary-trace",
      secondChildSessionId,
      "trace",
      JSON.stringify([
        {
          type: "tool_use",
          tool: "Search",
          input: {},
          id: "child-search",
          startedAt: "2026-07-14T00:00:00.000Z",
        },
        {
          type: "tool_result",
          tool: "Search",
          output: "done",
          toolUseId: "child-search",
          endedAt: "2026-07-14T00:00:02.000Z",
        },
        { type: "turn_end", turnId: secondChildTurnId, status: "completed", durationMs: 2000 },
      ]),
      secondChildTurnId,
    );
    await deps.webchatRepo.addMessage(
      "parent-summary-trace",
      parentSessionId,
      "trace",
      JSON.stringify([
        {
          type: "subagent_start",
          toolUseId: "delegate-planning",
          agentName: "planning",
          input: { prompt: "Plan it" },
          sessionId: childSessionId,
          turnId: childTurnId,
        },
        {
          type: "subagent_result",
          toolUseId: "delegate-planning",
          agentName: "planning",
          sessionId: childSessionId,
          turnId: childTurnId,
          status: "completed",
          output: "done",
        },
        {
          type: "subagent_start",
          toolUseId: "delegate-research",
          agentName: "research",
          input: { prompt: "Research it" },
          sessionId: secondChildSessionId,
          turnId: secondChildTurnId,
        },
        {
          type: "subagent_result",
          toolUseId: "delegate-research",
          agentName: "research",
          sessionId: secondChildSessionId,
          turnId: secondChildTurnId,
          status: "completed",
          output: "done",
        },
      ]),
      parentTurnId,
    );
    const app = createWebchatRuntime(deps).routes;
    const getTraceContentsByTurns = rs.spyOn(deps.webchatRepo, "getTraceContentsByTurns");
    const getTraceContentByTurn = rs.spyOn(deps.webchatRepo, "getTraceContentByTurn");

    const response = await app.request(`/chat/sessions/${parentSessionId}/messages`);
    expect(response.status).toBe(200);
    const messages = (await response.json()) as Array<{
      id: string;
      traceSummary?: {
        subagents?: Array<{
          agentName: string;
          status: string;
          traceSummary?: { totalSteps: number };
        }>;
      };
    }>;
    expect(
      messages.find((message) => message.id === "parent-summary-trace")?.traceSummary,
    ).toMatchObject({
      subagents: [
        { agentName: "planning", status: "completed", traceSummary: { totalSteps: 1 } },
        { agentName: "research", status: "completed", traceSummary: { totalSteps: 1 } },
      ],
    });
    expect(getTraceContentsByTurns).toHaveBeenCalledTimes(1);
    expect(getTraceContentsByTurns).toHaveBeenCalledWith([
      { sessionId: childSessionId, turnId: childTurnId },
      { sessionId: secondChildSessionId, turnId: secondChildTurnId },
    ]);
    expect(getTraceContentByTurn).not.toHaveBeenCalled();
    expect(await deps.webchatRepo.getMessageContent("parent-summary-trace")).not.toContain(
      "traceSummary",
    );
  });

  it("aggregates descendant token usage only on trace reads", async () => {
    const parentSessionId = "parent-usage-session";
    const parentTurnId = "parent-usage-turn";
    const childSessionId = "child-usage-session";
    const childTurnId = "child-usage-turn";
    const grandchildSessionId = "grandchild-usage-session";
    const grandchildTurnId = "grandchild-usage-turn";
    const usage = (
      cacheReadTokens: number,
      cacheWriteTokens: number,
      inputTokens: number,
      outputTokens: number,
    ) => ({ cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens });
    const terminal = (tokenUsage: ReturnType<typeof usage>, costUsd: number, model: string) => ({
      type: "result" as const,
      content: "done",
      accounting: { provider: "test", model, usage: tokenUsage, costUsd },
    });

    await deps.webchatRepo.createSession(parentSessionId, "Parent usage");
    await deps.webchatRepo.ensureRomeSession({
      id: childSessionId,
      type: "subagent",
      name: "Child usage",
      agentName: "planning",
      parentSessionId,
      parentTurnId,
    });
    await deps.webchatRepo.ensureRomeSession({
      id: grandchildSessionId,
      type: "subagent",
      name: "Grandchild usage",
      agentName: "research",
      parentSessionId: childSessionId,
      parentTurnId: childTurnId,
    });
    await deps.webchatRepo.addMessage(
      "grandchild-usage-trace",
      grandchildSessionId,
      "trace",
      JSON.stringify([
        {
          type: "result",
          content: "done",
          accounting: {
            provider: "test",
            model: "child-model",
            usage: { inputTokens: 3, outputTokens: 4 },
            costUsd: 0.03,
          },
        },
      ]),
      grandchildTurnId,
    );
    await deps.webchatRepo.addMessage(
      "child-usage-trace",
      childSessionId,
      "trace",
      JSON.stringify([
        {
          type: "subagent_start",
          toolUseId: "delegate-grandchild",
          agentName: "research",
          input: {},
          sessionId: grandchildSessionId,
          turnId: grandchildTurnId,
        },
        {
          type: "subagent_result",
          toolUseId: "delegate-grandchild",
          agentName: "research",
          sessionId: grandchildSessionId,
          turnId: grandchildTurnId,
          status: "completed",
          output: "done",
        },
        terminal(usage(10, 20, 30, 40), 0.2, "child-model"),
      ]),
      childTurnId,
    );
    await deps.webchatRepo.addMessage(
      "parent-usage-trace",
      parentSessionId,
      "trace",
      JSON.stringify([
        {
          type: "subagent_start",
          toolUseId: "delegate-child",
          agentName: "planning",
          input: {},
          sessionId: childSessionId,
          turnId: childTurnId,
        },
        {
          type: "subagent_result",
          toolUseId: "delegate-child",
          agentName: "planning",
          sessionId: childSessionId,
          turnId: childTurnId,
          status: "completed",
          output: "done",
        },
        {
          ...terminal(usage(100, 200, 300, 400), 1, "parent-model"),
          accounting: {
            ...terminal(usage(100, 200, 300, 400), 1, "parent-model").accounting,
            context: { usedTokens: 700, windowTokens: 1000 },
          },
        },
      ]),
      parentTurnId,
    );
    const app = createWebchatRuntime(deps).routes;
    const readAccounting = async (path: string) => {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { trace: TraceSnapshot };
      const result = payload.trace.segments.find(
        (segment) => segment.kind === "block" && segment.block.type === "result",
      );
      if (!result || result.kind !== "block" || result.block.type !== "result") {
        throw new Error("expected result block");
      }
      return result.block.accounting;
    };

    await expect(
      readAccounting("/chat/messages/parent-usage-trace/content"),
    ).resolves.toMatchObject({
      usage: usage(110, 220, 333, 444),
      costUsd: 1.23,
      context: { usedTokens: 700, windowTokens: 1000 },
      includedSubagentCount: 2,
      usageByModel: [
        {
          provider: "test",
          model: "parent-model",
          usage: usage(100, 200, 300, 400),
          costUsd: 1,
          runCount: 1,
        },
        {
          provider: "test",
          model: "child-model",
          usage: usage(10, 20, 33, 44),
          costUsd: 0.23,
          runCount: 2,
        },
      ],
    });
    await expect(
      readAccounting("/chat/messages/parent-usage-trace/content?includeSubagentUsage=false"),
    ).resolves.toMatchObject({
      usage: usage(100, 200, 300, 400),
      costUsd: 1,
    });
    await expect(
      readAccounting(`/sessions/${childSessionId}/turns/${childTurnId}/trace`),
    ).resolves.toMatchObject({
      usage: usage(10, 20, 33, 44),
      costUsd: 0.23,
      includedSubagentCount: 1,
      usageByModel: [
        {
          provider: "test",
          model: "child-model",
          usage: usage(10, 20, 33, 44),
          costUsd: 0.23,
          runCount: 2,
        },
      ],
    });
    expect(await deps.webchatRepo.getMessageContent("parent-usage-trace")).not.toContain(
      "includedSubagentCount",
    );
    expect(await deps.webchatRepo.getMessageContent("parent-usage-trace")).not.toContain(
      "usageByModel",
    );
  });

  describe("project routes", () => {
    it("lists first-class projects and materializes their workspaces", async () => {
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        defaultPath: string;
        projects: Array<{ displayName?: string; id?: string; name: string; path: string }>;
        rootPath: string;
      };
      expect(body.rootPath).toBe(projectsRoot);
      expect(body.defaultPath).toBe(join(projectsRoot, "default"));
      expect(body.projects).toEqual([
        expect.objectContaining({
          id: "default",
          name: "default",
          displayName: "default",
          path: join(projectsRoot, "default"),
        }),
      ]);
      expect(existsSync(join(projectsRoot, "default"))).toBe(true);
      await expect(deps.webchatRepo.getProjectByPath("default")).resolves.toMatchObject({
        id: "default",
        name: "default",
        path: "default",
      });
    });

    it("creates a project row and workspace together", async () => {
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "alpha" }),
      });

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({
        name: "alpha",
        displayName: "alpha",
        path: join(projectsRoot, "alpha"),
        projectPath: "alpha",
      });
      expect(existsSync(join(projectsRoot, "alpha"))).toBe(true);
      await expect(deps.webchatRepo.getProjectByPath("alpha")).resolves.toMatchObject({
        name: "alpha",
        path: "alpha",
      });
    });

    it("does not list or materialize archived projects", async () => {
      await deps.webchatRepo.createProject("alpha", "alpha");
      await deps.webchatRepo.archiveProjectsByPathPrefix("alpha");
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        projects: Array<{ name: string; path: string }>;
      };
      expect(body.projects.map((project) => project.name)).toEqual(["default"]);
      expect(existsSync(join(projectsRoot, "alpha"))).toBe(false);
    });

    it("does not restore an archived project through explicit creation after its workspace is gone", async () => {
      await deps.webchatRepo.createProject("alpha", "alpha");
      await deps.webchatRepo.archiveProjectsByPathPrefix("alpha");
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "alpha" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'Selected project "alpha" is unavailable',
      });
      expect(existsSync(join(projectsRoot, "alpha"))).toBe(false);
      await expect(deps.webchatRepo.getProjectByPath("alpha")).resolves.toBeNull();
    });

    it("does not restore an archived project through explicit creation while its workspace exists", async () => {
      await deps.webchatRepo.createProject("alpha", "alpha");
      await deps.webchatRepo.archiveProjectsByPathPrefix("alpha");
      mkdirSync(join(projectsRoot, "alpha"), { recursive: true });
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "alpha" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'Selected project "alpha" is unavailable',
      });
      await expect(deps.webchatRepo.getProjectByPath("alpha")).resolves.toBeNull();
    });

    it("rejects creating the reserved default project even before it is seeded", async () => {
      await testDb.db.delete(webchatProjects).where(eq(webchatProjects.path, "default"));
      await expect(deps.webchatRepo.getProjectByPath("default")).resolves.toBeNull();
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "default" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'Project "default" is reserved',
      });
      await expect(deps.webchatRepo.getProjectByPath("default")).resolves.toBeNull();
      expect(existsSync(join(projectsRoot, "default"))).toBe(false);
    });

    it("recovers when a project workspace already exists without a project row", async () => {
      mkdirSync(join(projectsRoot, "orphan"), { recursive: true });
      await expect(deps.webchatRepo.getProjectByPath("orphan")).resolves.toBeNull();
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "orphan" }),
      });

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({
        name: "orphan",
        displayName: "orphan",
        path: join(projectsRoot, "orphan"),
        projectPath: "orphan",
      });
      await expect(deps.webchatRepo.getProjectByPath("orphan")).resolves.toMatchObject({
        name: "orphan",
        path: "orphan",
      });
    });

    it("creates sessions for previously unknown nested projects", async () => {
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Unknown project", projectPath: "missing/nested" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        name: "Unknown project",
        projectName: "nested",
        projectPath: "missing/nested",
      });
      expect(existsSync(join(projectsRoot, "missing", "nested"))).toBe(true);
      await expect(deps.webchatRepo.getProjectByPath("missing/nested")).resolves.toMatchObject({
        name: "nested",
        path: "missing/nested",
      });
    });

    it("updates empty sessions to previously unknown nested projects", async () => {
      const app = createWebchatRuntime(deps).routes;
      const createRes = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Draft" }),
      });
      const session = (await createRes.json()) as { id: string };

      const res = await app.request(`/chat/sessions/${session.id}/project`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: "default/test" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        projectName: "test",
        projectPath: "default/test",
      });
      expect(existsSync(join(projectsRoot, "default", "test"))).toBe(true);
      await expect(deps.webchatRepo.getProjectByPath("default/test")).resolves.toMatchObject({
        name: "test",
        path: "default/test",
      });
    });

    it("does not create projects when rejecting a project change after messages exist", async () => {
      const app = createWebchatRuntime(deps).routes;
      const createRes = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Started" }),
      });
      const session = (await createRes.json()) as { id: string };
      await deps.webchatRepo.addMessage("started-message", session.id, "user", "hello");

      const res = await app.request(`/chat/sessions/${session.id}/project`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: "rejected/path" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: "Project cannot be changed after the first message",
      });
      await expect(deps.webchatRepo.getProjectByPath("rejected/path")).resolves.toBeNull();
      expect(existsSync(join(projectsRoot, "rejected", "path"))).toBe(false);
    });

    it("rejects archived projects when creating sessions", async () => {
      await deps.webchatRepo.createProject("alpha", "alpha");
      await deps.webchatRepo.archiveProjectsByPathPrefix("alpha");
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Archived project", projectPath: "alpha" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'Selected project "alpha" is unavailable',
      });
      expect(existsSync(join(projectsRoot, "alpha"))).toBe(false);
      await expect(deps.webchatRepo.getProjectByPath("alpha")).resolves.toBeNull();
    });

    it("rejects archived projects even while their workspace exists", async () => {
      await deps.webchatRepo.createProject("alpha", "alpha");
      await deps.webchatRepo.archiveProjectsByPathPrefix("alpha");
      mkdirSync(join(projectsRoot, "alpha"), { recursive: true });
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Recreated project", projectPath: "alpha" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: 'Selected project "alpha" is unavailable',
      });
      await expect(deps.webchatRepo.getProjectByPath("alpha")).resolves.toBeNull();
    });
  });

  it("returns activity and unread state for chat sessions and marks them read", async () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
    const app = createWebchatRuntime(deps).routes;

    const createRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Unread test" }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      activityAt: string;
      id: string;
      lastSeenActivityAt: string | null;
      unread: boolean;
    };
    expect(created.activityAt).toBe("2029-01-01T00:00:00.000Z");
    expect(created.lastSeenActivityAt).toBe("2029-01-01T00:00:00.000Z");
    expect(created.unread).toBe(false);

    rs.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await deps.webchatRepo.addMessage("unread-message", created.id, "assistant", "[]");

    const listRes = await app.request("/chat/sessions");
    expect(listRes.status).toBe(200);
    const sessions = (await listRes.json()) as Array<{
      activityAt: string;
      id: string;
      lastSeenActivityAt: string | null;
      unread: boolean;
    }>;
    expect(sessions.find((session) => session.id === created.id)).toMatchObject({
      activityAt: "2030-01-01T00:00:00.000Z",
      lastSeenActivityAt: "2029-01-01T00:00:00.000Z",
      unread: true,
    });

    const readRes = await app.request(`/chat/sessions/${created.id}/read`, { method: "POST" });
    expect(readRes.status).toBe(200);
    await expect(readRes.json()).resolves.toMatchObject({
      sessionId: created.id,
      lastSeenActivityAt: "2030-01-01T00:00:00.000Z",
      unread: false,
    });

    const afterReadRes = await app.request("/chat/sessions");
    const afterRead = (await afterReadRes.json()) as Array<{ id: string; unread: boolean }>;
    expect(afterRead.find((session) => session.id === created.id)).toMatchObject({
      unread: false,
    });
  });

  it("emits a content-free OTLP event after a chat session is created", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);
    const stdoutSpy = rs.spyOn(console, "log").mockImplementation(() => {});

    try {
      const app = createWebchatRuntime(deps).routes;
      const response = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Private title that must not enter telemetry" }),
      });
      expect(response.status).toBe(200);
      const created = (await response.json()) as { id: string };

      const creationRecords = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "webchat_session_created");
      expect(creationRecords).toHaveLength(1);
      expect(creationRecords[0]).toMatchObject({
        severityText: "info",
        attributes: {
          component: "api:webchat",
          "rome.log.source": "rome",
          sessionId: created.id,
          agentName: "main",
          projectPath: "default",
        },
      });
      expect(creationRecords[0].attributes).not.toHaveProperty("name");
      // No ambient session actor in this harness — the attributes must be
      // absent, not empty, mirroring the action_executions contract.
      expect(creationRecords[0].attributes).not.toHaveProperty("actorKind");
      expect(JSON.stringify(creationRecords[0])).not.toContain("Private title");
    } finally {
      stdoutSpy.mockRestore();
      logs.disable();
      await provider.shutdown();
    }
  });

  it("stamps the ambient session actor on session create/delete audit events", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);
    const stdoutSpy = rs.spyOn(console, "log").mockImplementation(() => {});

    try {
      const app = createWebchatRuntime(deps).routes;
      const createRes = await runWithSessionActor(
        {
          kind: "guardian",
          userId: "seat-1",
          accountId: "acct-1",
          email: "guardian@example.com",
          via: "cookie",
        },
        () =>
          app.request("/chat/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Actor test" }),
          }),
      );
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { id: string };

      const [creationRecord] = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "webchat_session_created");
      expect(creationRecord.attributes).toMatchObject({
        sessionId: created.id,
        actorKind: "guardian",
        actorUserId: "seat-1",
        actorAccountId: "acct-1",
        actorEmail: "guardian@example.com",
        actorVia: "cookie",
      });

      const deleteRes = await runWithSessionActor(
        { kind: "visitor", accountId: "acct-2", email: "visitor@example.com" },
        () => app.request(`/chat/sessions/${created.id}`, { method: "DELETE" }),
      );
      expect(deleteRes.status).toBe(200);

      const [deletionRecord] = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "webchat_session_deleted");
      expect(deletionRecord.attributes).toMatchObject({
        sessionId: created.id,
        actorKind: "visitor",
        actorAccountId: "acct-2",
        actorEmail: "visitor@example.com",
      });
      expect(deletionRecord.attributes).not.toHaveProperty("actorUserId");

      // Email-less actors must record their kind WITHOUT an email attribute —
      // downstream consumers (the ClickStack dashboard) rely on actorKind
      // being present to distinguish "recorded, no email" from unattributed
      // history, and must never fill an email in for these rows.
      const anonRes = await runWithSessionActor({ kind: "anonymous" }, () =>
        app.request("/chat/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Anonymous actor test" }),
        }),
      );
      expect(anonRes.status).toBe(200);
      const anonRecord = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "webchat_session_created")
        .at(-1);
      expect(anonRecord?.attributes).toMatchObject({ actorKind: "anonymous" });
      expect(anonRecord?.attributes).not.toHaveProperty("actorUserId");
      expect(anonRecord?.attributes).not.toHaveProperty("actorEmail");

      const localSeatRes = await runWithSessionActor(
        { kind: "guardian", userId: "seat-1", via: "cookie" },
        () =>
          app.request("/chat/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Password-only seat test" }),
          }),
      );
      expect(localSeatRes.status).toBe(200);
      const localSeatRecord = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "webchat_session_created")
        .at(-1);
      expect(localSeatRecord?.attributes).toMatchObject({
        actorKind: "guardian",
        actorUserId: "seat-1",
        actorVia: "cookie",
      });
      expect(localSeatRecord?.attributes).not.toHaveProperty("actorEmail");
      expect(localSeatRecord?.attributes).not.toHaveProperty("actorAccountId");
    } finally {
      stdoutSpy.mockRestore();
      logs.disable();
      await provider.shutdown();
    }
  });

  it("emits a content-free OTLP event after a chat session is deleted", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);
    const stdoutSpy = rs.spyOn(console, "log").mockImplementation(() => {});

    try {
      const sessionId = "delete-log-session";
      await deps.webchatRepo.createSession(
        sessionId,
        "Private title that must not enter telemetry",
        undefined,
        "default",
        null,
        "default",
        "main",
      );
      await deps.webchatRepo.addMessage(
        "delete-log-message",
        sessionId,
        "user",
        JSON.stringify({ text: "Private message that must not enter telemetry" }),
      );
      const app = createWebchatRuntime(deps).routes;

      const missing = await app.request("/chat/sessions/missing-delete-log-session", {
        method: "DELETE",
      });
      expect(missing.status).toBe(404);
      expect(
        exporter
          .getFinishedLogRecords()
          .filter((record) => record.body === "webchat_session_deleted"),
      ).toHaveLength(0);

      const response = await app.request(`/chat/sessions/${sessionId}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await expect(deps.webchatRepo.getSession(sessionId)).resolves.toBeNull();

      const deletionRecords = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "webchat_session_deleted");
      expect(deletionRecords).toHaveLength(1);
      expect(deletionRecords[0]).toMatchObject({
        severityText: "info",
        attributes: {
          component: "api:webchat",
          "rome.log.source": "rome",
          sessionId,
          agentName: "main",
          projectPath: "default",
          wasArchived: false,
          hadLiveAgentSession: false,
          reason: "user",
        },
      });
      expect(deletionRecords[0].attributes).not.toHaveProperty("sessionName");
      expect(deletionRecords[0].attributes).not.toHaveProperty("actorKind");
      expect(JSON.stringify(deletionRecords[0])).not.toContain("Private title");
      expect(JSON.stringify(deletionRecords[0])).not.toContain("Private message");
    } finally {
      stdoutSpy.mockRestore();
      logs.disable();
      await provider.shutdown();
    }
  });

  // Routes webchat's primary chat surface around ProviderAdapter.onMessage,
  // so the shared inbound-message log must fire at the accepted-turn boundary —
  // this drives the real POST route, not a mock channel port.
  it("logs the inbound message content to OTLP when a webchat turn is accepted", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);
    const stdoutSpy = rs.spyOn(console, "log").mockImplementation(() => {});

    try {
      deps.agentSessionManager = {
        acquire: rs.fn(
          async () =>
            ({
              key: { agentName: "main", channelThreadKey: "webchat:test" },
              sessionId: "agent-session",
              status: "idle",
              sendTurn() {
                return {
                  turnId: "turn-inbound-log",
                  events: (async function* () {
                    yield { type: "result", content: "" };
                  })(),
                  turnContext: otelContext.active(),
                };
              },
              subscribe: () => () => undefined,
              onStatusChange: () => () => undefined,
              interrupt: async () => undefined,
              close: async () => undefined,
            }) satisfies AgentSession,
        ),
        peek: () => undefined,
        shutdown: async () => undefined,
      };
      const app = createWebchatRuntime(deps).routes;

      const sessionRes = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Inbound log test" }),
      });
      const session = (await sessionRes.json()) as { id: string };

      const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "what's on my calendar?" }),
      });
      expect(sendRes.status).toBe(200);

      const records = exporter
        .getFinishedLogRecords()
        .filter((record) => record.body === "channel message received");
      expect(records).toHaveLength(1);

      const messages = await deps.webchatRepo.getMessages(session.id);
      const userMessage = messages.find((m) => m.role === "user");
      expect(userMessage).toBeDefined();
      expect(records[0]).toMatchObject({
        severityText: "info",
        attributes: {
          component: "channels",
          channel: "webchat",
          threadId: session.id,
          messageId: userMessage!.id,
          text: "what's on my calendar?",
        },
      });
    } finally {
      stdoutSpy.mockRestore();
      logs.disable();
      await provider.shutdown();
    }
  });

  describe("archive routes", () => {
    const createSession = async (
      app: ReturnType<typeof createWebchatRuntime>["routes"],
      name: string,
    ) => {
      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return (await res.json()) as { id: string };
    };

    it("archives and unarchives a session via PATCH and exposes archivedAt", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Archive route");

      const created = await app.request(`/chat/sessions/${session.id}`);
      expect((await created.json()) as { archivedAt: string | null }).toMatchObject({
        archivedAt: null,
      });

      const archiveRes = await app.request(`/chat/sessions/${session.id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(archiveRes.status).toBe(200);
      const archived = (await archiveRes.json()) as { id: string; archivedAt: string | null };
      expect(archived.id).toBe(session.id);
      expect(archived.archivedAt).toEqual(expect.any(String));

      const unarchiveRes = await app.request(`/chat/sessions/${session.id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      expect(unarchiveRes.status).toBe(200);
      expect((await unarchiveRes.json()) as { archivedAt: string | null }).toMatchObject({
        archivedAt: null,
      });
    });

    it("rejects a non-boolean archived body with 400", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Bad body");
      const res = await app.request(`/chat/sessions/${session.id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 archiving an unknown session", async () => {
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request("/chat/sessions/does-not-exist/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(res.status).toBe(404);
    });

    it("filters the session list by ?status", async () => {
      const app = createWebchatRuntime(deps).routes;
      const active = await createSession(app, "Active");
      const archived = await createSession(app, "Archived");
      await app.request(`/chat/sessions/${archived.id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });

      const activeList = (await (
        await app.request("/chat/sessions?status=active")
      ).json()) as Array<{
        id: string;
      }>;
      expect(activeList.map((s) => s.id)).toContain(active.id);
      expect(activeList.map((s) => s.id)).not.toContain(archived.id);

      const archivedList = (await (
        await app.request("/chat/sessions?status=archived")
      ).json()) as Array<{ id: string }>;
      expect(archivedList.map((s) => s.id)).toEqual([archived.id]);

      const allList = (await (await app.request("/chat/sessions?status=all")).json()) as Array<{
        id: string;
      }>;
      expect(allList.map((s) => s.id).sort()).toEqual([active.id, archived.id].sort());

      // Default (no query) is "active".
      const defaultList = (await (await app.request("/chat/sessions")).json()) as Array<{
        id: string;
      }>;
      expect(defaultList.map((s) => s.id)).not.toContain(archived.id);
    });

    it("refuses a turn to an archived session with 409", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Archived turn");
      await app.request(`/chat/sessions/${session.id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });

      const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(sendRes.status).toBe(409);
    });
  });

  describe("pin routes", () => {
    const createSession = async (
      app: ReturnType<typeof createWebchatRuntime>["routes"],
      name: string,
    ) => {
      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return (await res.json()) as { id: string };
    };

    it("pins and unpins a session via PATCH and exposes pinnedAt", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Pin route");

      const created = await app.request(`/chat/sessions/${session.id}`);
      expect((await created.json()) as { pinnedAt: string | null }).toMatchObject({
        pinnedAt: null,
      });

      const pinRes = await app.request(`/chat/sessions/${session.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      expect(pinRes.status).toBe(200);
      const pinned = (await pinRes.json()) as { id: string; pinnedAt: string | null };
      expect(pinned.id).toBe(session.id);
      expect(pinned.pinnedAt).toEqual(expect.any(String));

      const listRes = await app.request("/chat/sessions");
      const listed = (await listRes.json()) as Array<{ id: string; pinnedAt: string | null }>;
      expect(listed.find((candidate) => candidate.id === session.id)?.pinnedAt).toEqual(
        expect.any(String),
      );

      const unpinRes = await app.request(`/chat/sessions/${session.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: false }),
      });
      expect(unpinRes.status).toBe(200);
      expect((await unpinRes.json()) as { pinnedAt: string | null }).toMatchObject({
        pinnedAt: null,
      });
    });

    it("rejects a non-boolean pinned body with 400", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Bad pin body");
      const res = await app.request(`/chat/sessions/${session.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a null pinned body with 400", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Null pin body");
      const res = await app.request(`/chat/sessions/${session.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "pinned must be a boolean" });
    });

    it("returns 404 pinning an unknown session", async () => {
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request("/chat/sessions/does-not-exist/pin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("rename route", () => {
    const createSession = async (
      app: ReturnType<typeof createWebchatRuntime>["routes"],
      name: string,
    ) => {
      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return (await res.json()) as { id: string };
    };

    const rename = (
      app: ReturnType<typeof createWebchatRuntime>["routes"],
      id: string,
      name: unknown,
    ) =>
      app.request(`/chat/sessions/${id}/name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

    it("renames a session via PATCH and trims the name", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Before");

      const res = await rename(app, session.id, "  After  ");
      expect(res.status).toBe(200);
      expect((await res.json()) as { id: string; name: string }).toMatchObject({
        id: session.id,
        name: "After",
      });

      const fetched = await app.request(`/chat/sessions/${session.id}`);
      expect((await fetched.json()) as { name: string }).toMatchObject({ name: "After" });
    });

    it("rejects an empty or whitespace-only name with 400", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Keep me");
      expect((await rename(app, session.id, "   ")).status).toBe(400);
      expect((await rename(app, session.id, 42)).status).toBe(400);
    });

    it("rejects a null or non-object JSON body with 400 (not 500)", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Null body");
      for (const rawBody of ["null", '"just a string"', "[]"]) {
        const res = await app.request(`/chat/sessions/${session.id}/name`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: rawBody,
        });
        expect(res.status).toBe(400);
      }
    });

    it("rejects a name longer than 50 characters with 400", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Too long");
      expect((await rename(app, session.id, "x".repeat(51))).status).toBe(400);
    });

    it("counts user-perceived graphemes when validating a manual name", async () => {
      const app = createWebchatRuntime(deps).routes;
      const session = await createSession(app, "Emoji title");
      const family = "👨‍👩‍👧";

      expect((await rename(app, session.id, family.repeat(50))).status).toBe(200);
      expect((await rename(app, session.id, family.repeat(51))).status).toBe(400);
    });

    it("returns 404 renaming an unknown session", async () => {
      const app = createWebchatRuntime(deps).routes;
      expect((await rename(app, "does-not-exist", "Nope")).status).toBe(404);
    });
  });

  it("drops requested impersonation from new sessions unless enabled", async () => {
    const app = createWebchatRuntime(deps).routes;

    const res = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Impersonation off",
        personaId: baseline.persons.innerCircleId,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; personaId: string | null };
    expect(body.personaId).toBeNull();

    const session = await deps.webchatRepo.getSession(body.id);
    expect(session?.personaId).toBeNull();
  });

  it("preserves requested impersonation for new sessions when enabled", async () => {
    await deps.settingsRepo.set("enableImpersonation", true);
    const app = createWebchatRuntime(deps).routes;

    const res = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Impersonation on",
        personaId: baseline.persons.innerCircleId,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; personaId: string | null };
    expect(body.personaId).toBe(baseline.persons.innerCircleId);

    const session = await deps.webchatRepo.getSession(body.id);
    expect(session?.personaId).toBe(baseline.persons.innerCircleId);
  });

  it("passes requested reasoning effort to the agent session", async () => {
    let acquiredInit: AgentSessionInit | undefined;
    let sentTurn: AgentTurnInput | undefined;
    let sentOptions: SendTurnOptions | undefined;
    deps.agentSessionManager = {
      acquire: rs.fn(async (_key, init) => {
        acquiredInit = init;
        return {
          key: { agentName: "main", channelThreadKey: "webchat:test" },
          sessionId: "agent-session",
          status: "idle",
          sendTurn(input: AgentTurnInput, options?: SendTurnOptions) {
            sentTurn = input;
            sentOptions = options;
            return {
              turnId: "turn-1",
              events: (async function* () {
                yield { type: "result", content: "" };
              })(),
              turnContext: otelContext.active(),
            };
          },
          subscribe: () => () => undefined,
          onStatusChange: () => () => undefined,
          interrupt: async () => undefined,
          close: async () => undefined,
        } satisfies AgentSession;
      }),
      peek: () => undefined,
      shutdown: async () => undefined,
    };
    const app = createWebchatRuntime(deps).routes;

    const sessionRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reasoning test" }),
    });
    const session = (await sessionRes.json()) as { id: string };

    const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", reasoningEffort: "xhigh" }),
    });

    expect(sendRes.status).toBe(200);
    expect(acquiredInit?.reasoningEffort).toBe("xhigh");
    expect(sentTurn?.reasoningEffort).toBe("xhigh");
    expect(sentOptions).toMatchObject({
      romeSessionId: session.id,
      romeSessionType: "webchat",
    });
  });

  it("accepts a logged-out provider as a persisted failed turn", async () => {
    deps.agentSessionManager = {
      acquire: rs.fn(async () => {
        throw new ModelResolutionError("Selected model provider is unavailable: Codex", {
          code: "model_provider_unavailable",
          provider: "openai",
          reason: "not_logged_in",
        });
      }),
      peek: () => undefined,
      shutdown: async () => undefined,
    } as unknown as typeof deps.agentSessionManager;
    const app = createWebchatRuntime(deps).routes;

    const sessionRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Logged-out provider" }),
    });
    const session = (await sessionRes.json()) as { id: string };
    const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", largeModelSelection: "gpt-5-6-sol" }),
    });

    expect(sendRes.status).toBe(200);
    const turn = (await sendRes.json()) as { turnId: string; sessionId: string };
    expect(turn).toMatchObject({ sessionId: session.id, turnId: expect.any(String) });

    const messages = await deps.webchatRepo.getMessages(session.id);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          turnId: turn.turnId,
          content: JSON.stringify([{ type: "text", content: "hello" }]),
        }),
        expect.objectContaining({
          role: "assistant",
          turnId: turn.turnId,
          content: JSON.stringify([
            {
              type: "error",
              error: "Selected model provider is unavailable: Codex",
              code: "model_provider_unavailable",
              provider: "openai",
              reason: "not_logged_in",
            },
          ]),
        }),
      ]),
    );

    await rs.waitFor(async () => {
      const trace = await deps.webchatRepo.getTraceContentByTurn(session.id, turn.turnId);
      expect(trace).not.toBeNull();
      expect(JSON.parse(trace!.content)).toEqual([
        expect.objectContaining({ type: "turn_start", turnId: turn.turnId }),
        expect.objectContaining({
          type: "error",
          code: "model_provider_unavailable",
          provider: "openai",
          reason: "not_logged_in",
        }),
        expect.objectContaining({ type: "turn_end", status: "error", turnId: turn.turnId }),
      ]);
    });

    const streamRes = await app.request(`/chat/turns/${turn.turnId}/stream`);
    expect(streamRes.status).toBe(200);
    const sse = await streamRes.text();
    expect(sse).toContain("event: segment_upsert");
    expect(sse).toContain("model_provider_unavailable");
    expect(sse).toContain("event: done");
  });

  it("uses an LLM-generated summary to name a new chat from its first user message", async () => {
    deps.agentSessionManager = {
      acquire: rs.fn(async () => {
        throw new ModelResolutionError("Selected model provider is unavailable: Codex", {
          code: "model_provider_unavailable",
          provider: "openai",
          reason: "not_logged_in",
        });
      }),
      peek: () => undefined,
      shutdown: async () => undefined,
    } as unknown as typeof deps.agentSessionManager;
    const generateTitle = rs.fn(async () => "Q4 Launch Plan");
    deps.conversationTitleGenerator = { generate: generateTitle };
    const app = createWebchatRuntime(deps).routes;

    const create = async () => {
      const response = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Chat" }),
      });
      return (await response.json()) as { id: string };
    };
    const send = async (sessionId: string, text: string) => {
      const response = await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { turnId: string };
    };

    const session = await create();
    const sessionEvents = await app.request(`/chat/sessions/${session.id}/events`);
    const sessionEventsReader = sessionEvents.body!.getReader();
    const pendingSessionEvent = sessionEventsReader.read();
    const firstMessage =
      "Could you help me create a detailed launch plan for our fourth-quarter release?";
    await send(session.id, firstMessage);

    const sessionEvent = await pendingSessionEvent;
    expect(new TextDecoder().decode(sessionEvent.value)).toContain(
      `event: session_name\ndata: ${JSON.stringify({
        sessionId: session.id,
        name: "Q4 Launch Plan",
      })}`,
    );
    await sessionEventsReader.cancel();
    expect(generateTitle).toHaveBeenCalledOnce();
    expect(generateTitle).toHaveBeenCalledWith(firstMessage);
    expect((await deps.webchatRepo.getSession(session.id))?.name).toBe("Q4 Launch Plan");

    await send(session.id, "This later message must not replace the title");
    expect(generateTitle).toHaveBeenCalledOnce();
    expect((await deps.webchatRepo.getSession(session.id))?.name).toBe("Q4 Launch Plan");
  });

  it("does not delay the turn terminal event while conversation naming is still running", async () => {
    deps.agentSessionManager = {
      acquire: rs.fn(async () => {
        throw new ModelResolutionError("Selected model provider is unavailable: Codex", {
          code: "model_provider_unavailable",
          provider: "openai",
          reason: "not_logged_in",
        });
      }),
      peek: () => undefined,
      shutdown: async () => undefined,
    } as unknown as typeof deps.agentSessionManager;
    let finishTitle!: (title: string) => void;
    const generateTitle = rs.fn(
      () =>
        new Promise<string>((resolve) => {
          finishTitle = resolve;
        }),
    );
    deps.conversationTitleGenerator = { generate: generateTitle };
    const app = createWebchatRuntime(deps).routes;
    const sessionResponse = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Chat" }),
    });
    const session = (await sessionResponse.json()) as { id: string };

    const sendResponse = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Help me plan our Q4 launch" }),
    });
    const turn = (await sendResponse.json()) as { turnId: string };
    const stream = await app.request(`/chat/turns/${turn.turnId}/stream`);

    expect(await stream.text()).toContain("event: done");
    expect(generateTitle).toHaveBeenCalledOnce();
    expect((await deps.webchatRepo.getSession(session.id))?.name).toBe("New Chat");

    finishTitle("Q4 Launch Plan");
    await rs.waitFor(async () => {
      expect((await deps.webchatRepo.getSession(session.id))?.name).toBe("Q4 Launch Plan");
    });
  });

  describe("assistant text streaming (text_delta)", () => {
    // Drive a scripted turn through the drain loop and collect every SSE
    // event until `done`. `script` may await a gate the caller releases from
    // inside the reader (via onEvent) to exercise live emission, not replay.
    const runScriptedStream = async (
      script: () => AsyncGenerator<never>,
      onEvent?: (evt: { event: string; data: string }) => void,
    ) => {
      deps.agentSessionManager = {
        acquire: rs.fn(async (key) => ({
          key: { agentName: key.agentName, channelThreadKey: "webchat:stream" },
          sessionId: "agent-session",
          status: "idle",
          sendTurn() {
            return {
              turnId: "turn-stream-1",
              events: script(),
              turnContext: otelContext.active(),
            };
          },
          subscribe: () => () => undefined,
          onStatusChange: () => () => undefined,
          interrupt: async () => undefined,
          close: async () => undefined,
        })),
        peek: () => undefined,
        shutdown: async () => undefined,
      } as unknown as typeof deps.agentSessionManager;
      const sendMessageRun = rs.fn(async () => ({ status: "ok" }));
      deps.actionEngine = { run: sendMessageRun } as unknown as typeof deps.actionEngine;
      const app = createWebchatRuntime(deps).routes;

      const sessionRes = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Streaming test" }),
      });
      const session = (await sessionRes.json()) as { id: string };
      const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(sendRes.status).toBe(200);
      const { turnId } = (await sendRes.json()) as { turnId: string };

      const streamRes = await app.request(`/chat/turns/${turnId}/stream`);
      expect(streamRes.status).toBe(200);

      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Array<{ event: string; data: string }> = [];
      reading: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const evt = { event: "", data: "" };
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) evt.event = line.slice(6).trim();
            else if (line.startsWith("data:")) evt.data += line.slice(5).trim();
          }
          if (evt.event) {
            events.push(evt);
            onEvent?.(evt);
          }
          if (evt.event === "done") break reading;
        }
      }
      return { events, sendMessageRun, sessionId: session.id, app };
    };

    const assistantTexts = (events: Array<{ event: string; data: string }>) =>
      events
        .filter((e) => e.event === "assistant_text")
        .map((e) => {
          const { blockIx, text } = JSON.parse(e.data) as { blockIx: number; text: string };
          return { blockIx, text };
        });

    it("emits block-scoped accumulated text, survives tool_use, and keeps deltas out of the trace", async () => {
      // Gate the scripted stream so the tail runs only after the reader has
      // seen the first block — exercising live emission, not just replay.
      let releaseTail!: () => void;
      const tailGate = new Promise<void>((resolve) => (releaseTail = resolve));
      let released = false;
      const { events, sendMessageRun, sessionId } = await runScriptedStream(
        () =>
          (async function* () {
            yield { type: "text_delta", content: "Hel" };
            yield { type: "text_delta", content: "lo" };
            // The complete block closes the preview and advances blockIx.
            yield { type: "text", content: "Hello" };
            await tailGate;
            yield { type: "tool_use", id: "tu-1", tool: "some_tool", input: {} };
            yield { type: "tool_result", toolUseId: "tu-1", tool: "some_tool", output: {} };
            yield { type: "text_delta", content: "Final " };
            yield { type: "text_delta", content: "answer" };
            yield { type: "text", content: "Final answer" };
            yield { type: "result", content: "Final answer" };
          })() as AsyncGenerator<never>,
        (evt) => {
          if (
            !released &&
            evt.event === "assistant_text" &&
            (JSON.parse(evt.data) as { text: string }).text === "Hello"
          ) {
            released = true;
            releaseTail();
          }
        },
      );

      const texts = assistantTexts(events);
      // Pre-attach deltas may collapse into one replayed accumulation, but the
      // first observed text must already be accumulated (never a bare "lo").
      expect(texts[0]).toEqual({ blockIx: 0, text: "Hello" });
      // Delayed fold: tool_use emits nothing — no clearing sentinel, and the
      // previous block is replaced only by the next block's events.
      expect(texts.every((t) => t.text !== "")).toBe(true);
      // The post-tool deltas accumulate under the next block index.
      expect(texts[texts.length - 1]).toEqual({ blockIx: 1, text: "Final answer" });

      // The final reply goes through send_message with the result content.
      expect(sendMessageRun).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({ text: "Final answer" }),
        expect.anything(),
      );

      // Deltas are transient: the persisted trace must not contain them.
      const messages = await deps.webchatRepo.getMessages(sessionId);
      const trace = messages.find((m) => m.role === "trace");
      expect(trace).toBeTruthy();
      expect(trace!.content).not.toContain("text_delta");
    });

    it("persists each commentary block as its own live message; send_message carries only the final", async () => {
      const { sendMessageRun, sessionId } = await runScriptedStream(
        () =>
          (async function* () {
            yield { type: "text", content: "Let me check the weather.", turnPhase: "commentary" };
            yield { type: "tool_use", id: "tu-1", tool: "some_tool", input: {} };
            yield { type: "tool_result", toolUseId: "tu-1", tool: "some_tool", output: {} };
            yield { type: "text", content: "It's sunny.", turnPhase: "final" };
            yield { type: "result", content: "It's sunny." };
          })() as AsyncGenerator<never>,
      );

      // send_message carries only the final answer; commentary is its own message.
      expect(sendMessageRun).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({
          parts: [{ type: "text", content: "It's sunny.", turnPhase: "final", blockIx: 1 }],
        }),
        expect.anything(),
      );

      // The in-turn commentary block was persisted as its own assistant message
      // (pushed live), tagged commentary — not bundled into the final.
      const messages = await deps.webchatRepo.getMessages(sessionId);
      const commentary = messages.filter(
        (m) => m.role === "assistant" && m.content.includes('"commentary"'),
      );
      expect(commentary).toHaveLength(1);
      expect(JSON.parse(commentary[0].content)).toEqual([
        {
          type: "text",
          content: "Let me check the weather.",
          turnPhase: "commentary",
          blockIx: 0,
        },
      ]);
    });

    it("emits a corrective block event for providers that never stream deltas", async () => {
      // Codex-shaped turn: whole text blocks only. Each block must still
      // produce an assistant_text event so the live bubble works at block
      // granularity. Gate the result so the reader attaches before the turn
      // finishes — finishStream drops the assistant_text replay frame, so a
      // post-completion attach legitimately sees no preview.
      let releaseResult!: () => void;
      const resultGate = new Promise<void>((resolve) => (releaseResult = resolve));
      let released = false;
      const { events, sendMessageRun } = await runScriptedStream(
        () =>
          (async function* () {
            yield { type: "text", content: "Whole block" };
            await resultGate;
            yield { type: "result", content: "Whole block" };
          })() as AsyncGenerator<never>,
        (evt) => {
          if (!released && evt.event === "assistant_text") {
            released = true;
            releaseResult();
          }
        },
      );
      expect(assistantTexts(events)).toContainEqual({ blockIx: 0, text: "Whole block" });
      expect(sendMessageRun).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({
          parts: [{ type: "text", content: "Whole block", turnPhase: "final", blockIx: 0 }],
        }),
        expect.anything(),
      );
    });

    it("allocates a new final block after commentary even when the text is identical", async () => {
      const { sendMessageRun } = await runScriptedStream(
        () =>
          (async function* () {
            yield { type: "text", content: "Same text", turnPhase: "commentary" };
            yield { type: "result", content: "Same text" };
          })() as AsyncGenerator<never>,
      );

      expect(sendMessageRun).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({
          parts: [{ type: "text", content: "Same text", turnPhase: "final", blockIx: 1 }],
        }),
        expect.anything(),
      );
    });

    it("assigns block zero when a provider returns only a final result", async () => {
      const { sendMessageRun } = await runScriptedStream(
        () =>
          (async function* () {
            yield { type: "result", content: "Result only" };
          })() as AsyncGenerator<never>,
      );

      expect(sendMessageRun).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({
          parts: [{ type: "text", content: "Result only", turnPhase: "final", blockIx: 0 }],
        }),
        expect.anything(),
      );
    });

    it("streams Plan-only summary updates and reconstructs the latest Plan after settlement", async () => {
      let releaseResult!: () => void;
      const resultGate = new Promise<void>((resolve) => (releaseResult = resolve));
      let released = false;
      const { events, sessionId, app } = await runScriptedStream(
        () =>
          (async function* () {
            yield {
              type: "plan_update",
              plan: {
                explanation: "Working through the request",
                steps: [
                  { text: "Inspect", status: "completed" },
                  { text: "Implement", status: "in_progress" },
                ],
              },
            };
            await resultGate;
            yield { type: "result", content: "Done" };
          })() as AsyncGenerator<never>,
        (evt) => {
          if (released || evt.event !== "summary_update") return;
          const summary = JSON.parse(evt.data) as { plan?: unknown };
          if (!summary.plan) return;
          released = true;
          releaseResult();
        },
      );

      const planSummaryIndex = events.findIndex((event) => {
        if (event.event !== "summary_update") return false;
        return !!(JSON.parse(event.data) as { plan?: unknown }).plan;
      });
      expect(planSummaryIndex).toBeGreaterThanOrEqual(0);
      expect(
        events.slice(0, planSummaryIndex).some((event) => event.event === "segment_upsert"),
      ).toBe(false);

      const response = await app.request(`/chat/sessions/${sessionId}/messages`);
      const messages = (await response.json()) as Array<{
        role: string;
        traceSummary?: { plan?: unknown };
      }>;
      const trace = messages.find((message) => message.role === "trace");
      expect(trace?.traceSummary?.plan).toEqual({
        explanation: "Working through the request",
        steps: [
          { text: "Inspect", status: "completed" },
          { text: "Implement", status: "in_progress" },
        ],
      });
    });

    // An action that returns `place_widget` surfaces a `{ placeWidget: true, … }`
    // marker on its tool_result (the agent-session shim's shape). The drain loop
    // turns that into a transient `widget_placement` SSE event — fire-and-forget,
    // so no pending_interaction card is persisted and the turn is not parked.
    const placeWidgetEvents =
      (toolUseId: string, appId: string, extra: Record<string, unknown> = {}) =>
      () =>
        (async function* () {
          yield {
            type: "tool_result",
            toolUseId,
            tool: "execute_action",
            output: [
              {
                type: "text",
                text: JSON.stringify({ placeWidget: true, appId, ...extra }),
              },
            ],
          };
          yield { type: "result", content: "" };
        })() as AsyncGenerator<never>;

    it("emits a widget_placement event for a place_widget result, with no card and no park", async () => {
      deps.appCatalog = {
        listResolved: () => [{ appId: "workflow-studio", manifest: { components: [] } }],
      } as unknown as typeof deps.appCatalog;

      const { events, sessionId } = await runScriptedStream(
        placeWidgetEvents("tu-widget-1", "workflow-studio"),
      );

      const placement = events.find((e) => e.event === "widget_placement");
      expect(placement).toBeDefined();
      expect(JSON.parse(placement!.data)).toEqual({
        appId: "workflow-studio",
      });

      // Fire-and-forget: unlike a pending_interaction, nothing is persisted.
      const messages = await deps.webchatRepo.getMessages(sessionId);
      const hasCard = messages.some((m) => {
        if (m.role !== "assistant") return false;
        try {
          const parts = JSON.parse(m.content) as unknown[];
          return (
            Array.isArray(parts) &&
            parts.some((p) => (p as { type?: unknown })?.type === "pending_interaction")
          );
        } catch {
          return false;
        }
      });
      expect(hasCard).toBe(false);
    });

    it("does not emit widget_placement when the owning app is not installed (fail closed)", async () => {
      deps.appCatalog = {
        listResolved: () => [],
      } as unknown as typeof deps.appCatalog;

      const { events } = await runScriptedStream(placeWidgetEvents("tu-widget-2", "ghost-app"));

      expect(events.some((e) => e.event === "widget_placement")).toBe(false);
    });

    it("emits a widget placement for the host-owned Sessions app", async () => {
      deps.appCatalog = {
        listResolved: () => [],
      } as unknown as typeof deps.appCatalog;

      const { events } = await runScriptedStream(
        placeWidgetEvents("tu-widget-sessions", "sessions", {
          route: "feedback-fork-session",
        }),
      );

      const placement = events.find((event) => event.event === "widget_placement");
      expect(placement).toBeDefined();
      expect(JSON.parse(placement!.data)).toEqual({
        appId: "sessions",
        route: "feedback-fork-session",
      });
    });

    it("carries route and scalar params through the widget_placement event", async () => {
      deps.appCatalog = {
        listResolved: () => [{ appId: "orders", manifest: { components: [] } }],
      } as unknown as typeof deps.appCatalog;

      const { events } = await runScriptedStream(
        placeWidgetEvents("tu-widget-3", "orders", {
          route: "orders/123",
          params: { tab: "history" },
        }),
      );

      const placement = events.find((e) => e.event === "widget_placement");
      expect(placement).toBeDefined();
      expect(JSON.parse(placement!.data)).toEqual({
        appId: "orders",
        route: "orders/123",
        params: { tab: "history" },
      });
    });

    it("drops malformed params (non-scalar values never reach the iframe src)", async () => {
      deps.appCatalog = {
        listResolved: () => [{ appId: "orders", manifest: { components: [] } }],
      } as unknown as typeof deps.appCatalog;

      const { events } = await runScriptedStream(
        placeWidgetEvents("tu-widget-4", "orders", {
          params: { orderId: 123, junk: { nested: true } },
        }),
      );

      const placement = events.find((e) => e.event === "widget_placement");
      expect(placement).toBeDefined();
      expect(JSON.parse(placement!.data)).toEqual({
        appId: "orders",
        params: { orderId: 123 },
      });
    });
  });

  describe("turn cancellation", () => {
    const setupStop = async (tail: "result" | "partial" | "error" = "result") => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const interrupt = rs.fn(async () => undefined);
      const wrongTurnInterrupt = rs.fn(async () => undefined);
      deps.agentSessionManager = {
        acquire: rs.fn(async () => ({
          key: { agentName: "main" },
          sessionId: "runtime",
          status: "running",
          sendTurn: () => ({
            turnId: "cancel-turn",
            interrupt,
            turnContext: otelContext.active(),
            events: (async function* () {
              yield {
                type: "turn_start",
                turnId: "cancel-turn",
                sessionId: "runtime",
                userPrompt: "work",
              };
              yield {
                type: "tool_use",
                id: "edit-1",
                tool: "Edit",
                input: { file_path: "test.txt" },
              };
              yield {
                type: "tool_result",
                toolUseId: "edit-1",
                tool: "Edit",
                output: "File changed",
              };
              if (tail === "partial")
                yield { type: "text_delta", content: "Already changed the file" };
              await gate;
              if (tail === "result") yield { type: "result", content: "Already changed the file" };
              if (tail === "error") yield { type: "error", error: "Actual provider failure" };
              yield {
                type: "turn_end",
                turnId: "cancel-turn",
                status: tail === "error" ? "error" : "interrupted",
                durationMs: 10,
              };
            })(),
          }),
          subscribe: () => () => undefined,
          onStatusChange: () => () => undefined,
          interrupt: wrongTurnInterrupt,
        })),
        peek: rs.fn(),
        shutdown: async () => undefined,
      } as unknown as typeof deps.agentSessionManager;
      const sendMessageRun = rs.fn(async () => ({ status: "ok" }));
      deps.actionEngine = { run: sendMessageRun } as unknown as typeof deps.actionEngine;
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stop test" }),
      });
      const { id: sessionId } = (await res.json()) as { id: string };
      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "work" }),
      });
      return {
        app,
        sessionId,
        interrupt,
        wrongTurnInterrupt,
        sendMessageRun,
        release,
        stop: () => app.request("/chat/turns/cancel-turn/interrupt", { method: "POST" }),
        finish: async () => {
          release();
          const stream = await app.request("/chat/turns/cancel-turn/stream");
          return await stream.text();
        },
      };
    };

    it.each([
      "result",
      "partial",
    ] as const)("preserves %s output and tool evidence after repeated Stop", async (tail) => {
      const h = await setupStop(tail);
      expect((await h.stop()).status).toBe(202);
      expect(await (await h.stop()).json()).toEqual({ stopped: false });
      expect(h.interrupt).toHaveBeenCalledTimes(2);
      expect(h.wrongTurnInterrupt).not.toHaveBeenCalled();
      const stream = await h.finish();
      expect(stream).toContain('"stopped":true');
      expect(h.sendMessageRun).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({ text: "Already changed the file" }),
        expect.anything(),
      );
      const trace = await deps.webchatRepo.getTraceContentByTurn(h.sessionId, "cancel-turn");
      expect(trace!.content).toContain("File changed");
      expect(trace!.content).toContain("edit-1");
      if (tail === "partial") expect(trace!.content).toContain("Already changed the file");
      expect((await h.stop()).status).toBe(404);
    });

    it("permits retry after cancellation fails and does not hide a later provider error", async () => {
      const h = await setupStop("error");
      h.interrupt.mockRejectedValueOnce(new Error("Stop transport failed"));
      expect((await h.stop()).status).toBe(500);
      expect((await h.stop()).status).toBe(202);
      expect(h.interrupt).toHaveBeenCalledTimes(2);
      const stream = await h.finish();
      expect(stream).toContain("Actual provider failure");
      expect(stream).toContain('"success":false');
      expect(stream).toContain('"stopped":false');
      expect(h.sendMessageRun).not.toHaveBeenCalled();
    });
  });

  it("expands a slash-skill command for the model but persists the raw text", async () => {
    let sentTurn: AgentTurnInput | undefined;
    deps.agentSessionManager = {
      acquire: rs.fn(async () => {
        return {
          key: { agentName: "main", channelThreadKey: "webchat:test" },
          sessionId: "agent-session",
          status: "idle",
          sendTurn(input: AgentTurnInput) {
            sentTurn = input;
            return {
              turnId: "turn-1",
              events: (async function* () {
                yield { type: "result", content: "" };
              })(),
              turnContext: otelContext.active(),
            };
          },
          subscribe: () => () => undefined,
          onStatusChange: () => () => undefined,
          interrupt: async () => undefined,
          close: async () => undefined,
        } satisfies AgentSession;
      }),
      peek: () => undefined,
      shutdown: async () => undefined,
    };
    deps.skillCatalog = {
      get: (name) =>
        name === "app_creation" || name === "@ray/calendar:daily_brief"
          ? ({ name } as never)
          : undefined,
      getAll: () => [{ name: "app_creation" }, { name: "@ray/calendar:daily_brief" }] as never[],
      getRegistryLoadFailures: () => [],
    };
    const app = createWebchatRuntime(deps).routes;

    const sessionRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Slash test" }),
    });
    const session = (await sessionRes.json()) as { id: string };

    const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/app_creation build a habit tracker" }),
    });

    expect(sendRes.status).toBe(200);
    // Model sees the read_skill instruction, not the raw slash text.
    expect(sentTurn?.prompt).toContain('invoked the skill "app_creation"');
    expect(sentTurn?.prompt).toContain("Task: build a habit tracker");
    // Transcript keeps the command exactly as typed.
    const messages = await deps.webchatRepo.getMessages(session.id);
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("/app_creation build a habit tracker");

    // Scoped app ids retain their publisher namespace in typed slash turns.
    const scopedRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/@ray/calendar:daily_brief summarize today" }),
    });
    expect(scopedRes.status).toBe(200);
    expect(sentTurn?.prompt).toContain('invoked the skill "@ray/calendar:daily_brief"');
    expect(sentTurn?.prompt).toContain("Task: summarize today");
    const scopedMessages = await deps.webchatRepo.getMessages(session.id);
    expect(
      scopedMessages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("/@ray/calendar:daily_brief summarize today"),
      ),
    ).toBe(true);

    // A slash token that names no catalog skill passes through untouched.
    const passthroughRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/unknown do something" }),
    });
    expect(passthroughRes.status).toBe(200);
    expect(sentTurn?.prompt).toBe("/unknown do something");
  });

  it("expands a structured skillName field, winning over typed-slash text parsing", async () => {
    let sentTurn: AgentTurnInput | undefined;
    deps.agentSessionManager = {
      acquire: rs.fn(async () => {
        return {
          key: { agentName: "main", channelThreadKey: "webchat:test" },
          sessionId: "agent-session",
          status: "idle",
          sendTurn(input: AgentTurnInput) {
            sentTurn = input;
            return {
              turnId: "turn-1",
              events: (async function* () {
                yield { type: "result", content: "" };
              })(),
              turnContext: otelContext.active(),
            };
          },
          subscribe: () => () => undefined,
          onStatusChange: () => () => undefined,
          interrupt: async () => undefined,
          close: async () => undefined,
        } satisfies AgentSession;
      }),
      peek: () => undefined,
      shutdown: async () => undefined,
    };
    // The structured field is the composer chip's explicit selection — it
    // resolves against the catalog independently of any typed text.
    deps.skillCatalog = {
      get: (name) => (name === "research:deep-research" ? ({ name } as never) : undefined),
      getAll: () => [{ name: "research:deep-research" } as never],
      getRegistryLoadFailures: () => [],
    };
    const app = createWebchatRuntime(deps).routes;

    const sessionRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Structured skill test" }),
    });
    const session = (await sessionRes.json()) as { id: string };

    const sendRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "solar panel payback",
        skillName: "research:deep-research",
      }),
    });
    expect(sendRes.status).toBe(200);
    expect(sentTurn?.prompt).toContain('invoked the skill "research:deep-research"');
    expect(sentTurn?.prompt).toContain("Task: solar panel payback");
    // Transcript shows the invocation in command form.
    const messages = await deps.webchatRepo.getMessages(session.id);
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("/deep-research solar panel payback");

    // A skill selection with no task text is a valid turn by itself.
    const bareRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "research:deep-research" }),
    });
    expect(bareRes.status).toBe(200);
    expect(sentTurn?.prompt).toContain("did not include any task text");

    // An unknown skillName degrades to a plain text turn (mirror of the
    // typed-slash pass-through)…
    const unknownRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "just text", skillName: "gone" }),
    });
    expect(unknownRes.status).toBe(200);
    expect(sentTurn?.prompt).toBe("just text");

    // …and with nothing else in the turn there is nothing to send.
    const emptyRes = await app.request(`/chat/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "gone" }),
    });
    expect(emptyRes.status).toBe(400);
  });

  describe("suspensions (handoff + inline pending_interaction)", () => {
    // Drive the drain loop with a scripted event stream per turn so we can
    // observe what the route does when an action returns a handoff / inline
    // tool_result, and how a later interaction_result re-drives the agent.
    function mockScriptedManager() {
      const sentTurns: AgentTurnInput[] = [];
      const acquiredAgents: string[] = [];
      // The drain loop fail-closes a suspension unless its owning app is
      // installed (and, for an inline component, declares the component id). Wire
      // a minimal catalog resolving the apps these tests park onto.
      deps.appCatalog = {
        listResolved: () => [
          { appId: "workflow-studio", manifest: { components: [] } },
          { appId: "ask-user", manifest: { components: ["question-card"] } },
        ],
      } as unknown as typeof deps.appCatalog;
      let scripted: () => AsyncGenerator<unknown> = async function* () {
        yield { type: "result", content: "" };
      };
      deps.agentSessionManager = {
        acquire: rs.fn((key, _init) => {
          acquiredAgents.push(key.agentName);
          const session = {
            key: { agentName: key.agentName, channelThreadKey: "webchat:suspend" },
            sessionId: "agent-session",
            status: "idle",
            sendTurn(input: AgentTurnInput) {
              sentTurns.push(input);
              return {
                turnId: `turn-${sentTurns.length}`,
                events: scripted() as AsyncGenerator<never>,
                turnContext: otelContext.active(),
              };
            },
            subscribe: () => () => undefined,
            onStatusChange: () => () => undefined,
            interrupt: async () => undefined,
            close: async () => undefined,
          } satisfies AgentSession;
          return Promise.resolve(session);
        }),
        peek: () => undefined,
        shutdown: async () => undefined,
      };
      return {
        sentTurns,
        acquiredAgents,
        setEvents(fn: () => AsyncGenerator<unknown>) {
          scripted = fn;
        },
      };
    }

    async function newSession(app: ReturnType<typeof createWebchatRuntime>["routes"]) {
      const res = await app.request("/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Suspend test" }),
      });
      return ((await res.json()) as { id: string }).id;
    }

    async function findCard(sessionId: string, toolUseId: string) {
      // The card is persisted by the background drain, so poll briefly.
      for (let i = 0; i < 100; i++) {
        const messages = await deps.webchatRepo.getMessages(sessionId);
        for (const m of messages) {
          if (m.role !== "assistant") continue;
          let parts: unknown;
          try {
            parts = JSON.parse(m.content);
          } catch {
            continue;
          }
          if (!Array.isArray(parts)) continue;
          const card = parts.find(
            (p) =>
              p &&
              typeof p === "object" &&
              ((p as { type?: unknown }).type === "pending_interaction" ||
                (p as { type?: unknown }).type === "handoff") &&
              (p as { toolUseId?: unknown }).toolUseId === toolUseId,
          );
          if (card) return card as Record<string, unknown>;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return undefined;
    }

    const handoffEvents = (toolUseId: string) =>
      async function* () {
        // Mirror the real MCP facade tool_result shape: the action's JSON is
        // wrapped in a `[{ type: "text", text }]` content block, not handed back
        // as a bare object — the drain loop must unwrap it.
        yield {
          type: "tool_result",
          toolUseId,
          tool: "execute_action",
          output: [
            {
              type: "text",
              text: JSON.stringify({
                handoff: true,
                appId: "workflow-studio",
                agentName: "workflow-studio:workflow-planner",
              }),
            },
          ],
        };
        yield { type: "result", content: "" };
      };

    it("snapshots a handoff card when an action returns a handoff", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(handoffEvents("tu-park-1"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      const res = await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "build me a daily digest workflow" }),
      });
      expect(res.status).toBe(200);

      const card = await findCard(sessionId, "tu-park-1");
      expect(card).toMatchObject({
        type: "handoff",
        toolUseId: "tu-park-1",
        appId: "workflow-studio",
        agentName: "workflow-studio:workflow-planner",
      });
    });

    it("mints a child handoff session locked to the specialist agent and links it via the card", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(handoffEvents("tu-child-1"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "design a workflow" }),
      });

      const card = await findCard(sessionId, "tu-child-1");
      const childSessionId = card?.childSessionId;
      // The design conversation gets its own session — never the parent's.
      expect(typeof childSessionId).toBe("string");
      expect(childSessionId).not.toBe(sessionId);

      const child = await deps.webchatRepo.getSession(childSessionId as string);
      expect(child?.type).toBe("webchat_handoff");
      expect(child?.agentName).toBe("workflow-studio:workflow-planner");
    });

    it("keeps spawned handoff sessions out of the top-level session list", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(handoffEvents("tu-hidden-1"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "design a workflow" }),
      });
      const card = await findCard(sessionId, "tu-hidden-1");
      const childSessionId = card?.childSessionId as string;
      expect(childSessionId).toBeDefined();

      const listRes = await app.request("/chat/sessions");
      const ids = ((await listRes.json()) as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain(sessionId);
      expect(ids).not.toContain(childSessionId);
    });

    it("re-drives the calling agent with the artifact when the surface resolves", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(handoffEvents("tu-park-2"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "design a workflow" }),
      });
      expect(await findCard(sessionId, "tu-park-2")).toBeDefined();

      // The surface posts the authored artifact back as an interaction_result.
      ctl.setEvents(async function* () {
        yield { type: "result", content: "" };
      });
      const artifact = {
        ir: { path: "/x/ir.json", digest: { name: "Morning digest", stepCount: 3 } },
      };
      const resolveRes = await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "interaction_result", toolUseId: "tu-park-2", output: artifact }],
        }),
      });
      expect(resolveRes.status).toBe(200);

      // The model's resume prompt carries the artifact, not raw prose.
      const resumePrompt = ctl.sentTurns.at(-1)?.prompt ?? "";
      expect(resumePrompt).toContain("Morning digest");
      expect(resumePrompt).toContain("resolved with this result");

      // The interaction_result part is persisted verbatim for the transcript.
      const messages = await deps.webchatRepo.getMessages(sessionId);
      const userParts = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => {
          try {
            return JSON.parse(m.content) as unknown[];
          } catch {
            return [];
          }
        });
      expect(
        userParts.some(
          (p) =>
            p && typeof p === "object" && (p as { type?: unknown }).type === "interaction_result",
        ),
      ).toBe(true);
    });

    it("frames a dismissal so the agent does not retry", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(handoffEvents("tu-park-3"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "design a workflow" }),
      });
      expect(await findCard(sessionId, "tu-park-3")).toBeDefined();

      ctl.setEvents(async function* () {
        yield { type: "result", content: "" };
      });
      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            { type: "interaction_result", toolUseId: "tu-park-3", output: { dismissed: true } },
          ],
        }),
      });

      const resumePrompt = ctl.sentTurns.at(-1)?.prompt ?? "";
      expect(resumePrompt.toLowerCase()).toContain("dismissed");
    });

    it("rejects an interaction_result whose toolUseId has no pending card (fail closed)", async () => {
      mockScriptedManager();
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      const res = await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "interaction_result", toolUseId: "never-parked", output: { ir: {} } }],
        }),
      });
      expect(res.status).toBe(400);
    });

    // An inline component goes through the same suspension lifecycle as a
    // handoff — toolUseId-keyed card and resolution — but keeps its own
    // `pending_interaction` part type and spawns no child session.
    const inlineRenderEvents = (toolUseId: string, appId: string, componentId: string) =>
      async function* () {
        yield {
          type: "tool_result",
          toolUseId,
          tool: "execute_action",
          output: [
            {
              type: "text",
              text: JSON.stringify({
                pendingInteraction: true,
                appId,
                render: { kind: "inline", componentId, props: { q: "ok?" } },
              }),
            },
          ],
        };
        yield { type: "result", content: "" };
      };

    it("snapshots an inline pending_interaction card with no child session", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(inlineRenderEvents("tu-inline-1", "ask-user", "question-card"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ask me something" }),
      });

      const card = await findCard(sessionId, "tu-inline-1");
      expect(card).toMatchObject({
        type: "pending_interaction",
        toolUseId: "tu-inline-1",
        appId: "ask-user",
        render: { kind: "inline", componentId: "question-card" },
      });
      // Inline interactions resolve in-place — no spawned design session.
      expect(card?.childSessionId).toBeUndefined();
    });

    it("does not persist an inline render whose component the app never declared (fail closed)", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(inlineRenderEvents("tu-inline-2", "ask-user", "not-declared"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      const res = await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ask me something" }),
      });
      expect(res.status).toBe(200);
      // The drain rejects the undeclared component, so no card is ever written.
      const card = await findCard(sessionId, "tu-inline-2");
      expect(card).toBeUndefined();
    });

    it("does not persist a parked interaction whose owning app is not installed (fail closed)", async () => {
      const ctl = mockScriptedManager();
      ctl.setEvents(inlineRenderEvents("tu-ghost-1", "ghost-app", "whatever"));
      const app = createWebchatRuntime(deps).routes;
      const sessionId = await newSession(app);

      await app.request(`/chat/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "ask me something" }),
      });
      expect(await findCard(sessionId, "tu-ghost-1")).toBeUndefined();
    });
  });

  describe("turn feedback routes", () => {
    const SESSION_ID = "sess-fb-routes";
    const TURN_ID = "turn-fb-1";

    async function anchorTurn(sessionId: string, turnId: string) {
      // Persist a trace row so the POST handler's "turn belongs to session"
      // check passes; mirrors the real-world state where the feedback footer
      // only renders once the turn's trace row has been written.
      const id = `${sessionId}-${turnId}-anchor`;
      await deps.webchatRepo.addMessage(
        id,
        sessionId,
        "trace",
        JSON.stringify([{ type: "turn_end", turnId, status: "completed", durationMs: 10 }]),
        turnId,
      );
    }

    beforeEach(async () => {
      await deps.webchatRepo.createSession(SESSION_ID, "Feedback Routes");
      await anchorTurn(SESSION_ID, TURN_ID);
    });

    it("returns null when no feedback has been submitted", async () => {
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ feedback: null });
    });

    it("404s GET and POST when the session is missing", async () => {
      const app = createWebchatRuntime(deps).routes;
      const get = await app.request(`/chat/sessions/missing/turns/${TURN_ID}/feedback`);
      expect(get.status).toBe(404);

      const post = await app.request(`/chat/sessions/missing/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative" }),
      });
      expect(post.status).toBe(404);
    });

    it("404s GET when the turn is not anchored to this session", async () => {
      // Mirror the POST anchoring check on the read side — a stray turnId
      // copy-pasted from another session must not look like a clean slate.
      const app = createWebchatRuntime(deps).routes;
      const otherSession = "sess-other-get";
      const foreignTurn = "turn-foreign-get";
      await deps.webchatRepo.createSession(otherSession, "Other Session");
      await deps.webchatRepo.addMessage(
        "anchor-foreign-get",
        otherSession,
        "trace",
        "[]",
        foreignTurn,
      );

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${foreignTurn}/feedback`);
      expect(res.status).toBe(404);
    });

    it("does not expose a DELETE route (write-once semantics)", async () => {
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "DELETE",
      });
      // Hono returns 404 for an unmatched method+path pair.
      expect(res.status).toBe(404);
    });

    it("rejects POST when the turnId is not anchored to this session", async () => {
      // Seed a turn that belongs to a different session, then POST it under
      // SESSION_ID. The handler must refuse, so a stray or copy-pasted turnId
      // can't create feedback rows keyed to the wrong session.
      const otherSession = "sess-other";
      const foreignTurn = "turn-foreign";
      await deps.webchatRepo.createSession(otherSession, "Other Session");
      await anchorTurn(otherSession, foreignTurn);

      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${foreignTurn}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative" }),
      });
      expect(res.status).toBe(404);
      await expect(deps.webchatRepo.getTurnFeedback(SESSION_ID, foreignTurn)).resolves.toBeNull();
    });

    it("round-trips a rating + comment", async () => {
      const app = createWebchatRuntime(deps).routes;
      const post = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative", comment: "  wrong answer  " }),
      });
      expect(post.status).toBe(200);
      const body = (await post.json()) as {
        feedback: { rating: string; comment: string | null; updatedAt: number };
      };
      expect(body.feedback).toMatchObject({ rating: "negative", comment: "wrong answer" });
      expect(typeof body.feedback.updatedAt).toBe("number");

      const get = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`);
      const echoed = (await get.json()) as typeof body;
      expect(echoed.feedback).toMatchObject({ rating: "negative", comment: "wrong answer" });
    });

    it("processes written feedback in an exact fork and shows its Sessions record", async () => {
      // Seed the rated exchange plus a later turn: the fork inherits the
      // source transcript at its head, so the prompt must quote the rated
      // turn's exchange verbatim rather than pointing at "the latest turn".
      await deps.webchatRepo.addMessage(
        "fb-rated-user",
        SESSION_ID,
        "user",
        JSON.stringify([{ type: "text", content: "What is the capital of Australia?" }]),
        TURN_ID,
      );
      await deps.webchatRepo.addMessage(
        "fb-rated-assistant",
        SESSION_ID,
        "assistant",
        JSON.stringify([{ type: "text", content: "The capital of Australia is Sydney." }]),
        TURN_ID,
      );
      const laterTurn = "turn-fb-later";
      await anchorTurn(SESSION_ID, laterTurn);
      await deps.webchatRepo.addMessage(
        "fb-later-user",
        SESSION_ID,
        "user",
        JSON.stringify([{ type: "text", content: "Now tell me about Rome." }]),
        laterTurn,
      );
      await deps.webchatRepo.addMessage(
        "fb-later-assistant",
        SESSION_ID,
        "assistant",
        JSON.stringify([{ type: "text", content: "Rome is the capital of Italy." }]),
        laterTurn,
      );

      const originalRunner = deps.agentRunner;
      let forkParams: ForkRunParams | null = null;
      deps.agentRunner = {
        run: originalRunner.run.bind(originalRunner),
        async *runForked(params) {
          forkParams = params;
          yield {
            type: "turn_start",
            turnId: "feedback-fork-turn",
            sessionId: "feedback-fork-session",
            userPrompt: params.prompt,
          };
          yield { type: "result", content: "Understood and saved the durable preference." };
          yield {
            type: "turn_end",
            turnId: "feedback-fork-turn",
            status: "completed",
            durationMs: 1,
          };
        },
      };
      rs.spyOn(deps.agentSessionManager, "acquire").mockResolvedValue({
        sessionId: "live-source-session",
      } as AgentSession);
      rs.spyOn(deps.sessionManager, "getTurnCheckpoint").mockResolvedValue({
        sessionId: "live-source-session",
        turnId: TURN_ID,
        provider: "openai",
        providerThreadId: "source-provider-thread",
        checkpointId: "rated-provider-turn",
      });
      const showApp = rs.spyOn(deps.actionEngine, "run").mockResolvedValue({
        status: "place_widget",
        placement: { appId: "sessions", route: "feedback-fork-session" },
      });

      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: "negative",
          comment: "Please be more direct and remember that I prefer short answers.",
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        feedback: {
          rating: "negative",
          comment: "Please be more direct and remember that I prefer short answers.",
        },
        processing: { appId: "sessions", route: "feedback-fork-session" },
      });
      expect(forkParams).toMatchObject({
        agentName: "main",
        sourceSessionId: "live-source-session",
        channelThreadKey: `webchat:${SESSION_ID}`,
        parentTurnId: TURN_ID,
        label: "feedback",
        mode: "exact",
        sourceCheckpoint: {
          providerId: "openai",
          providerThreadId: "source-provider-thread",
          checkpointId: "rated-provider-turn",
        },
      });
      const capturedFork = forkParams as ForkRunParams | null;
      expect(capturedFork?.prompt).toContain(
        "Please be more direct and remember that I prefer short answers.",
      );
      expect(capturedFork?.prompt).toContain("save only that useful learning to the user's memory");
      expect(capturedFork?.prompt).toContain("create or update a skill in the user's skills");
      expect(capturedFork?.prompt.slice(0, 200)).not.toContain("Please be more direct");
      // The prompt anchors to the rated exchange, quoted verbatim — not to
      // the later turn that now sits at the transcript head.
      expect(capturedFork?.prompt).toContain("What is the capital of Australia?");
      expect(capturedFork?.prompt).toContain("The capital of Australia is Sydney.");
      expect(capturedFork?.prompt).not.toContain("Now tell me about Rome.");
      expect(capturedFork?.prompt).not.toContain("Rome is the capital of Italy.");
      expect(showApp).toHaveBeenCalledWith(
        "show_app",
        { appId: "sessions", route: "feedback-fork-session" },
        expect.objectContaining({
          initiator: "system:turn-feedback",
          sessionId: "feedback-fork-session",
          turnId: "feedback-fork-turn",
        }),
      );
    });

    it("stores feedback but skips processing when the rated exchange has no chat text", async () => {
      // TURN_ID is anchored by a trace row only (see anchorTurn). Without a
      // persisted user/assistant exchange the fork prompt cannot quote the
      // rated turn, so processing must not start — a fork anchored to the
      // transcript head could learn from the wrong exchange.
      const runForked = rs.fn();
      deps.agentRunner = {
        run: deps.agentRunner.run.bind(deps.agentRunner),
        runForked,
      };
      const showApp = rs.spyOn(deps.actionEngine, "run");
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative", comment: "this was wrong" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { feedback: { comment: string | null } };
      expect(body.feedback).toMatchObject({ rating: "negative", comment: "this was wrong" });
      expect(body).not.toHaveProperty("processing");
      expect(runForked).not.toHaveBeenCalled();
      expect(showApp).not.toHaveBeenCalled();
    });

    it("does not start feedback processing when no text was set", async () => {
      const runForked = rs.fn();
      deps.agentRunner = {
        run: deps.agentRunner.run.bind(deps.agentRunner),
        runForked,
      };
      const showApp = rs.spyOn(deps.actionEngine, "run");
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "positive" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.not.toHaveProperty("processing");
      expect(runForked).not.toHaveBeenCalled();
      expect(showApp).not.toHaveBeenCalled();
    });

    it("rejects invalid rating values", async () => {
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "meh" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects oversize comments", async () => {
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative", comment: "x".repeat(2001) }),
      });
      expect(res.status).toBe(400);
    });

    it("round-trips a positive rating that carries a comment", async () => {
      // Both thumbs open the optional-comment form in the UI, so the server
      // accepts a comment with either rating.
      const app = createWebchatRuntime(deps).routes;
      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "positive", comment: "nice job" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { feedback: { rating: string; comment: string | null } };
      expect(body.feedback).toMatchObject({ rating: "positive", comment: "nice job" });
      await expect(deps.webchatRepo.getTurnFeedback(SESSION_ID, TURN_ID)).resolves.toMatchObject({
        rating: "positive",
        comment: "nice job",
      });
    });

    it("accepts a positive rating with no comment / empty comment", async () => {
      const app = createWebchatRuntime(deps).routes;
      const omit = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "positive" }),
      });
      expect(omit.status).toBe(200);
    });

    it("write-once is atomic at the DB layer (concurrent POSTs)", async () => {
      // Fire two POSTs back-to-back without awaiting between them. With
      // INSERT ... ON CONFLICT DO NOTHING + composite PK, exactly one wins;
      // the other sees zero rows inserted and is mapped to 409. This is what
      // closes the TOCTOU window between an upsert-style "check then write"
      // path: there is no check — the database is the gate.
      const app = createWebchatRuntime(deps).routes;
      const post = (rating: string, comment: string) =>
        app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating, comment }),
        });

      const [a, b] = await Promise.all([post("negative", "first"), post("negative", "second")]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      // The winning POST's comment is what landed; the row was written once.
      const winner = a.status === 200 ? "first" : "second";
      const row = await deps.webchatRepo.getTurnFeedback(SESSION_ID, TURN_ID);
      expect(row?.comment).toBe(winner);
    });

    it("session delete cascades feedback rows via the FK constraint", async () => {
      // Defense-in-depth: even if a future delete path forgets to call
      // deleteTurnFeedback / deleteSession's explicit feedback delete, the
      // FK ON DELETE CASCADE keeps the contract.
      const app = createWebchatRuntime(deps).routes;
      const post = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative", comment: "leaks?" }),
      });
      expect(post.status).toBe(200);
      await expect(deps.webchatRepo.getTurnFeedback(SESSION_ID, TURN_ID)).resolves.not.toBeNull();

      await deps.webchatRepo.deleteSession(SESSION_ID);
      await expect(deps.webchatRepo.getTurnFeedback(SESSION_ID, TURN_ID)).resolves.toBeNull();
    });

    it("rejects a second submit with 409 and preserves the first record", async () => {
      // Feedback is write-once. A second POST on the same turn (e.g. from a
      // stale tab) must not overwrite the first; it returns 409 plus the
      // existing record so the client can lock to it.
      const app = createWebchatRuntime(deps).routes;
      const first = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative", comment: "first" }),
      });
      expect(first.status).toBe(200);

      const second = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "negative", comment: "overwrite attempt" }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as {
        error: string;
        feedback: { rating: string; comment: string | null };
      };
      expect(body.feedback).toMatchObject({ rating: "negative", comment: "first" });

      const row = await deps.webchatRepo.getTurnFeedback(SESSION_ID, TURN_ID);
      expect(row).toMatchObject({ rating: "negative", comment: "first" });
    });

    it("emits exactly one OTLP feedback event per turn", async () => {
      // With write-once semantics rome-obs sees one log row per turn, so
      // downstream analytics don't need to dedup or take latest-by-timestamp.
      const logSpy = rs.spyOn(console, "log").mockImplementation(() => {});
      try {
        const app = createWebchatRuntime(deps).routes;
        await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "negative", comment: "first" }),
        });
        // Subsequent POSTs are rejected with 409 (see write-once test); they
        // must not emit additional `webchat_turn_feedback` events.
        await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "negative", comment: "retry" }),
        });

        const feedbackLines = logSpy.mock.calls
          .map((args) => (typeof args[0] === "string" ? args[0] : ""))
          .filter((line) => line.includes('"webchat_turn_feedback"'));
        expect(feedbackLines).toHaveLength(1);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("does not include the comment body in the OTLP log payload", async () => {
      // The local SQLite row keeps the comment; the OTLP log carries length
      // + rating only so user-typed text (which may include code, names, or
      // accidental secrets) never leaves the user's VM.
      const COMMENT = "private feedback text that must not leave the box";
      const logSpy = rs.spyOn(console, "log").mockImplementation(() => {});
      try {
        const app = createWebchatRuntime(deps).routes;
        const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "negative", comment: COMMENT }),
        });
        expect(res.status).toBe(200);

        const feedbackLines = logSpy.mock.calls
          .map((args) => (typeof args[0] === "string" ? args[0] : ""))
          .filter((line) => line.includes("webchat_turn_feedback"));
        expect(feedbackLines.length).toBeGreaterThan(0);
        for (const line of feedbackLines) {
          expect(line).not.toContain(COMMENT);
          const parsed = JSON.parse(line) as {
            data?: Record<string, unknown>;
          };
          expect(parsed.data).toBeDefined();
          expect(parsed.data).not.toHaveProperty("comment");
          expect(parsed.data?.commentLength).toBe(COMMENT.length);
          expect(parsed.data?.rating).toBe("negative");
        }
      } finally {
        logSpy.mockRestore();
      }

      // The local row should still hold the verbatim comment.
      await expect(deps.webchatRepo.getTurnFeedback(SESSION_ID, TURN_ID)).resolves.toMatchObject({
        comment: COMMENT,
      });
    });
  });

  describe("turn side-chat branch route", () => {
    const SESSION_ID = "sess-branch-routes";
    const TURN_ID = "turn-branch-1";

    beforeEach(async () => {
      await deps.webchatRepo.createSession(SESSION_ID, "Branch Routes");
      await deps.webchatRepo.addMessage(
        "branch-anchor",
        SESSION_ID,
        "trace",
        JSON.stringify([
          { type: "turn_end", turnId: TURN_ID, status: "completed", durationMs: 10 },
        ]),
        TURN_ID,
      );
    });

    it("resumes the source, runs an exact fork, and shows its Sessions route", async () => {
      await deps.webchatRepo.addMessage(
        "branch-later-anchor",
        SESSION_ID,
        "trace",
        "[]",
        "turn-branch-later",
      );
      const originalRunner = deps.agentRunner;
      let forkParams: ForkRunParams | null = null;
      deps.agentRunner = {
        run: originalRunner.run.bind(originalRunner),
        async *runForked(params) {
          forkParams = params;
          yield {
            type: "turn_start",
            turnId: "branch-fork-turn",
            sessionId: "branch-fork-session",
            userPrompt: params.prompt,
          };
          yield { type: "result", content: "Here is the side-chat answer." };
          yield {
            type: "turn_end",
            turnId: "branch-fork-turn",
            status: "completed",
            durationMs: 1,
          };
        },
      };
      const acquireSource = rs.spyOn(deps.agentSessionManager, "acquire").mockResolvedValue({
        sessionId: "live-source-session",
      } as AgentSession);
      rs.spyOn(deps.sessionManager, "getTurnCheckpoint").mockResolvedValue({
        sessionId: "live-source-session",
        turnId: TURN_ID,
        provider: "openai",
        providerThreadId: "source-provider-thread",
        checkpointId: "provider-turn-t2",
      });
      const showApp = rs.spyOn(deps.actionEngine, "run").mockResolvedValue({
        status: "place_widget",
        placement: { appId: "sessions", route: "branch-fork-session" },
      });
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/forks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "  Visualize this in a Mermaid chart  " }),
      });

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({
        placement: { appId: "sessions", route: "branch-fork-session" },
      });
      expect(forkParams).toMatchObject({
        agentName: "main",
        sourceSessionId: "live-source-session",
        prompt: "Visualize this in a Mermaid chart",
        channelThreadKey: `webchat:${SESSION_ID}`,
        parentTurnId: TURN_ID,
        label: "branch",
        mode: "exact",
        sourceCheckpoint: {
          providerId: "openai",
          providerThreadId: "source-provider-thread",
          checkpointId: "provider-turn-t2",
        },
      });
      expect(acquireSource).toHaveBeenCalledWith(
        { agentName: "main", channelThreadKey: `webchat:${SESSION_ID}` },
        expect.objectContaining({
          workingDir: join(projectsRoot, "default"),
          selectionId: undefined,
          threadContext: expect.objectContaining({
            channel: "webchat",
            threadId: SESSION_ID,
          }),
        }),
      );
      expect(showApp).toHaveBeenCalledWith(
        "show_app",
        { appId: "sessions", route: "branch-fork-session" },
        expect.objectContaining({
          initiator: "system:turn-branch",
          sessionId: "branch-fork-session",
          turnId: "branch-fork-turn",
        }),
      );
    });

    it("refuses a stopped turn before acquiring or reading provider history", async () => {
      await deps.webchatRepo.addMessage(
        "branch-user",
        SESSION_ID,
        "user",
        JSON.stringify([{ type: "text", content: "Run the long task" }]),
        TURN_ID,
      );
      await deps.webchatRepo.addMessage(
        "branch-assistant",
        SESSION_ID,
        "assistant",
        JSON.stringify([{ type: "text", content: "Partial work before Stop" }]),
        TURN_ID,
      );
      await deps.webchatRepo.appendTraceBlocks({
        messageId: "branch-anchor",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        startSeq: 0,
        blocks: [{ type: "turn_end", turnId: TURN_ID, status: "interrupted", durationMs: 10 }],
      });
      const runForked = rs.fn(() => (async function* () {})());
      deps.agentRunner = {
        run: deps.agentRunner.run.bind(deps.agentRunner),
        runForked,
      };
      const acquireSource = rs.spyOn(deps.agentSessionManager, "acquire").mockResolvedValue({
        sessionId: "live-source-session",
      } as AgentSession);
      const exactCheckpoint = rs.spyOn(deps.sessionManager, "getTurnCheckpoint").mockResolvedValue({
        sessionId: "live-source-session",
        turnId: "turn-before-stop",
        provider: "anthropic",
        providerThreadId: "claude-thread",
        checkpointId: "durable-assistant-before-stop",
      });
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/forks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Explain what happened" }),
      });

      expect(res.status).toBe(409);
      expect(acquireSource).not.toHaveBeenCalled();
      expect(exactCheckpoint).not.toHaveBeenCalled();
      expect(runForked).not.toHaveBeenCalled();
    });

    it("rejects missing turns and invalid prompts", async () => {
      deps.agentRunner = {
        run: deps.agentRunner.run.bind(deps.agentRunner),
        async *runForked() {},
      };
      const app = createWebchatRuntime(deps).routes;
      const post = (turnId: string, body: unknown) =>
        app.request(`/chat/sessions/${SESSION_ID}/turns/${turnId}/forks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await post("missing-turn", { prompt: "hello" })).status).toBe(404);
      expect((await post(TURN_ID, { prompt: "   " })).status).toBe(400);
      expect((await post(TURN_ID, { prompt: 42 })).status).toBe(400);
      expect(
        (await post(TURN_ID, { prompt: "x".repeat(TURN_BRANCH_PROMPT_MAX_LENGTH + 1) })).status,
      ).toBe(400);
    });

    it("returns a conflict when the persisted source conversation cannot be resumed", async () => {
      deps.agentRunner = {
        run: deps.agentRunner.run.bind(deps.agentRunner),
        async *runForked() {},
      };
      rs.spyOn(deps.agentSessionManager, "acquire").mockRejectedValue(
        new Error("source provider session is unavailable"),
      );
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/forks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Explain this" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: "Couldn't start side chat from this conversation",
      });
    });

    it("returns a conflict instead of forking from the head when the turn checkpoint is missing", async () => {
      const runForked = rs.fn(() => (async function* () {})());
      deps.agentRunner = {
        run: deps.agentRunner.run.bind(deps.agentRunner),
        runForked,
      };
      rs.spyOn(deps.agentSessionManager, "acquire").mockResolvedValue({
        sessionId: "live-source-session",
      } as AgentSession);
      rs.spyOn(deps.sessionManager, "getTurnCheckpoint").mockResolvedValue(null);
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${SESSION_ID}/turns/${TURN_ID}/forks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Explain this" }),
      });

      expect(res.status).toBe(409);
      expect(runForked).not.toHaveBeenCalled();
    });
  });

  describe("session message events", () => {
    it("retries backend continuation Stop without interrupting a later provider turn", async () => {
      const sessionId = "sess-backend-stop";
      await deps.webchatRepo.createSession(sessionId, "Backend stop");
      const owner = { currentTurnId: "backend-provider-turn", interrupt: rs.fn(async () => {}) };
      rs.spyOn(deps.agentSessionManager, "peek").mockReturnValue(owner as unknown as AgentSession);
      const { routes, runtime } = createWebchatRuntime(deps);
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const task = runtime.enqueueSessionTask(sessionId, async ({ emit }) => {
        emit({
          type: "turn_start",
          turnId: "backend-provider-turn",
          sessionId: "provider-session",
          userPrompt: "Continue",
        });
        await gate;
        emit({ type: "result", content: "Already changed the file." });
        emit({
          type: "turn_end",
          turnId: "backend-provider-turn",
          status: "interrupted",
          durationMs: 1,
        });
      });
      let turnId = "";
      await rs.waitFor(async () => {
        const turns = await (await routes.request(`/chat/sessions/${sessionId}/turns`)).json();
        turnId = turns[0]?.turnId;
        expect(turnId).toMatch(/^backend:/);
      });
      const stop = () => routes.request(`/chat/turns/${turnId}/interrupt`, { method: "POST" });
      expect((await stop()).status).toBe(202);
      expect((await stop()).status).toBe(202);
      expect(owner.interrupt).toHaveBeenCalledTimes(2);
      owner.currentTurnId = "later-turn";
      await stop();
      expect(owner.interrupt).toHaveBeenCalledTimes(2);
      finish();
      await task;
      expect(
        (await deps.webchatRepo.getMessages(sessionId)).some((m) =>
          m.content.includes("Already changed the file."),
        ),
      ).toBe(true);
      await runtime.flushAll();
    });

    it("emits message_insert when a turn recap row is inserted", async () => {
      const sessionId = "sess-recap-events";
      const turnId = "turn-recap-events";
      await deps.webchatRepo.createSession(sessionId, "Recap Events");
      await deps.webchatRepo.addMessage("recap-anchor", sessionId, "user", "[]", turnId);
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request(`/chat/sessions/${sessionId}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const pendingRead = reader.read();

      const recap = await deps.webchatRepo.addTurnRecapMessage({
        sessionId,
        turnId,
        content: "The turn recap is available.",
      });

      const chunk = await pendingRead;
      expect(chunk.done).toBe(false);
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: message_insert");
      expect(text).toContain(recap.id);
      expect(text).toContain("turn_recap");

      await reader.cancel();
    });

    it("pushes the resumed agent's reply as a durable assistant message after approval (no reload)", async () => {
      // GWT (Approvals): given a session paused on
      // an approval, when the guardian approves and the resumed agent replies,
      // the reply appears in the chat as a durable assistant message pushed to
      // the open session view. `enqueueSessionTask` is the exact seam the
      // ApprovalHandler drives the continuation through; a `result` message is
      // the resumed agent's final reply.
      const sessionId = "sess-approval-reply";
      await deps.webchatRepo.createSession(sessionId, "Approval Reply");
      const { routes: app, runtime } = createWebchatRuntime(deps);

      // The guardian's open session view subscribes to the session's stream.
      const res = await app.request(`/chat/sessions/${sessionId}/events`);
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const pendingRead = reader.read();

      // The approval continuation resumes the agent and emits its reply.
      await runtime.enqueueSessionTask(sessionId, async ({ emit }) => {
        emit({ type: "result", content: "Done — I sent the message." });
      });

      // Live: the open view receives a message_insert for the reply, with no
      // reload or session switch.
      const chunk = await pendingRead;
      expect(chunk.done).toBe(false);
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: message_insert");
      expect(text).toContain("Done — I sent the message.");
      await reader.cancel();

      // Durable: the reply survives a reload as a single assistant message.
      const messages = await deps.webchatRepo.getMessages(sessionId);
      const assistantReplies = messages.filter((m) => m.role === "assistant");
      expect(assistantReplies).toHaveLength(1);
      expect(assistantReplies[0]!.content).toContain("Done — I sent the message.");
    });

    it("persists an ask_question card emitted by a deferred backend continuation", async () => {
      // A `defer` wake-up resumes through enqueueSessionTask rather than the
      // foreground HTTP turn drain. The resumed agent must still be able to
      // park on ask_question and render the host-owned form.
      const sessionId = "sess-deferred-question";
      await deps.webchatRepo.createSession(sessionId, "Deferred Question");
      const { runtime } = createWebchatRuntime(deps);
      const toolUseId = "deferred-ask-1";
      const questions = [
        {
          id: "scope",
          question: "Which scope?",
          type: "single",
          options: ["Small", "Large"],
          freeText: true,
        },
      ];

      await runtime.enqueueSessionTask(sessionId, async ({ emit }) => {
        emit({
          type: "tool_result",
          tool: "ask_question",
          toolUseId,
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  pendingInteraction: true,
                  appId: "core",
                  render: {
                    kind: "inline",
                    componentId: "question-card",
                    props: { questions },
                    builtin: true,
                  },
                }),
              },
            ],
          },
        });
        emit({ type: "result", content: "Choose the scope above." });
      });

      const messages = await deps.webchatRepo.getMessages(sessionId);
      const assistantParts = messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => JSON.parse(message.content) as Array<Record<string, unknown>>);
      expect(assistantParts).toContainEqual({
        type: "pending_interaction",
        toolUseId,
        appId: "core",
        render: {
          kind: "inline",
          componentId: "question-card",
          props: { questions },
          builtin: true,
        },
      });
      expect(assistantParts).toContainEqual({
        type: "text",
        content: "Choose the scope above.",
      });
    });

    it("returns 404 for message events on a missing session", async () => {
      const app = createWebchatRuntime(deps).routes;

      const res = await app.request("/chat/sessions/missing/events");

      expect(res.status).toBe(404);
    });

    it("emits keepalive events on idle message event streams", async () => {
      rs.useFakeTimers();
      const sessionId = "sess-recap-events-keepalive";
      await deps.webchatRepo.createSession(sessionId, "Recap Events Keepalive");
      const app = createWebchatRuntime(deps).routes;

      try {
        const res = await app.request(`/chat/sessions/${sessionId}/events`);
        expect(res.status).toBe(200);
        expect(res.body).not.toBeNull();
        const reader = res.body!.getReader();
        const pendingRead = reader.read();

        await rs.advanceTimersByTimeAsync(20_000);

        const chunk = await pendingRead;
        expect(chunk.done).toBe(false);
        const text = new TextDecoder().decode(chunk.value);
        expect(text).toContain("event: keepalive");

        await reader.cancel();
      } finally {
        rs.useRealTimers();
      }
    });
  });
});

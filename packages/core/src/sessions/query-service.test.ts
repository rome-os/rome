import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { romeAgentMessages } from "../db/schema.js";
import { SessionQueryRepository } from "../db/repositories/session-query.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { SessionQueryService } from "./query-service.js";

describe("SessionQueryService", () => {
  let testDb: TestDb;
  let webchat: WebChatRepository;
  let service: SessionQueryService;

  beforeEach(() => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    testDb = createTestDb();
    webchat = new WebChatRepository(testDb.db);
    const codeReviewAgent = {
      metadata: { ownerType: "app" as const, ownerId: "code-review" },
    };
    const skillReviewAgent = {
      metadata: { ownerType: "app" as const, ownerId: "code-review" },
    };
    const currentRecords = new Map([
      ["code-review:code-review-agent", codeReviewAgent],
      ["code-review:skill_review", skillReviewAgent],
    ]);
    const resolvableRecords = new Map([
      ...currentRecords,
      ["code-review-agent", codeReviewAgent] as const,
    ]);
    service = new SessionQueryService({
      repository: new SessionQueryRepository(testDb.db),
      agentLoader: {
        getRecord: (name) => {
          const record = resolvableRecords.get(name);
          if (!record) throw new Error(`Agent ${name} not found`);
          return record;
        },
        getAllResolvableRecords: () => new Map(resolvableRecords),
      },
      appCatalog: {
        listResolved: () => [
          {
            appId: "code-review",
            displayName: "Code Review",
            iconAbsolutePath: "/tmp/code-review.png",
          },
        ],
      },
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  async function seedRun(input: {
    messageId: string;
    sessionId: string;
    turnId: string;
    createdAt: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    status: "completed" | "interrupted" | "error";
  }) {
    await webchat.appendTraceBlocks({
      messageId: input.messageId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      startSeq: 0,
      blocks: [
        {
          type: input.status === "error" ? "error" : "result",
          content: input.status === "error" ? "failed" : "done",
          accounting: {
            provider: input.provider,
            model: input.model,
            usage: {
              inputTokens: input.inputTokens,
              outputTokens: input.outputTokens,
              cacheReadTokens: input.cacheReadTokens ?? 0,
              cacheWriteTokens: input.cacheWriteTokens ?? 0,
            },
            costUsd: input.costUsd,
          },
        },
        {
          type: "turn_end",
          turnId: input.turnId,
          status: input.status,
          durationMs: 1_000,
        },
      ],
    });
    await testDb.db
      .update(romeAgentMessages)
      .set({ createdAt: new Date(input.createdAt) })
      .where(eq(romeAgentMessages.id, input.messageId));
  }

  it("derives model, outcome, and app projections from canonical trace data", async () => {
    await webchat.ensureRomeSession({
      id: "review-session",
      type: "action",
      name: "code-review-agent:opaque-id",
      agentName: "code-review-agent",
      projectName: "Rome",
      projectPath: "/workspace/rome",
      trigger: { triggerName: "code_review_pr_review" },
    });
    await seedRun({
      messageId: "run-gpt",
      sessionId: "review-session",
      turnId: "turn-gpt",
      createdAt: "2026-07-14T09:00:00.000Z",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      costUsd: 0.12,
      status: "completed",
    });
    await seedRun({
      messageId: "run-claude",
      sessionId: "review-session",
      turnId: "turn-claude",
      createdAt: "2026-07-15T10:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      costUsd: 0.3,
      status: "error",
    });

    const result = await service.queryMetrics({
      scope: { time: { kind: "all" }, timeZone: "UTC" },
      projections: [
        {
          id: "trend",
          groupBy: "model",
          interval: "day",
          rankBy: "tokens",
          limit: 6,
          includeOther: true,
        },
        {
          id: "breakdown",
          groupBy: "app",
          interval: "none",
          rankBy: "runs",
          limit: 50,
        },
        {
          id: "agents",
          groupBy: "agent",
          interval: "none",
          rankBy: "runs",
          limit: 50,
        },
      ],
    });

    expect(result.totals).toEqual({
      sessionCount: 1,
      runCount: 2,
      usage: {
        inputTokens: 31,
        outputTokens: 15,
        cacheReadTokens: 6,
        cacheWriteTokens: 4,
        totalTokens: 56,
        costUsd: 0.42,
        costedRunCount: 2,
      },
      outcomes: { completed: 1, interrupted: 0, error: 1, unknown: 0 },
    });
    expect(result.projections[0]?.groups).toEqual([
      expect.objectContaining({
        key: "model:anthropic:claude-sonnet-4.5",
        runCount: 1,
        usage: expect.objectContaining({ totalTokens: 35 }),
      }),
      expect.objectContaining({
        key: "model:openai:gpt-5.4",
        runCount: 1,
        usage: expect.objectContaining({ totalTokens: 21 }),
      }),
    ]);
    expect(result.projections[0]?.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bucket: "2026-07-14", runCount: 1 }),
        expect.objectContaining({ bucket: "2026-07-15", runCount: 1 }),
      ]),
    );
    expect(result.projections[1]?.groups).toEqual([
      expect.objectContaining({
        key: "app:code-review",
        label: "Code Review",
        sessionCount: 1,
        runCount: 2,
        iconUrl: "/api/apps/code-review/icon",
      }),
    ]);
    expect(result.projections[2]?.groups).toEqual([
      expect.objectContaining({
        key: "agent:code-review-agent",
        label: "Code Review Agent",
        description: "Code Review",
        iconUrl: "/api/apps/code-review/icon",
      }),
    ]);
  });

  it("builds display titles from the local part of canonical agent ids", async () => {
    await webchat.ensureRomeSession({
      id: "canonical-agent-session",
      type: "subagent",
      name: "",
      agentName: "code-review:skill_review",
    });
    await seedRun({
      messageId: "canonical-agent-run",
      sessionId: "canonical-agent-session",
      turnId: "canonical-agent-turn",
      createdAt: "2026-07-15T10:00:00.000Z",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 1,
      outputTokens: 1,
      status: "completed",
    });

    const result = await service.querySessions({
      scope: { time: { kind: "all" }, timeZone: "UTC" },
      page: { offset: 0, limit: 10 },
    });

    expect(result.sessions).toEqual([
      expect.objectContaining({
        id: "canonical-agent-session",
        agentName: "code-review:skill_review",
        displayTitle: "Skill Review",
        owner: expect.objectContaining({ label: "Code Review" }),
      }),
    ]);
  });

  it("attributes legacy session agent names through current canonical records", async () => {
    await webchat.ensureRomeSession({
      id: "legacy-agent-session",
      type: "action",
      name: "legacy agent",
      agentName: "code-review-agent",
    });
    await seedRun({
      messageId: "legacy-agent-run",
      sessionId: "legacy-agent-session",
      turnId: "legacy-agent-turn",
      createdAt: "2026-07-15T10:00:00.000Z",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 4,
      outputTokens: 2,
      costUsd: 0.25,
      status: "completed",
    });
    await webchat.ensureRomeSession({
      id: "removed-agent-session",
      type: "action",
      name: "removed agent",
      agentName: "removed-agent",
    });
    await seedRun({
      messageId: "removed-agent-run",
      sessionId: "removed-agent-session",
      turnId: "removed-agent-turn",
      createdAt: "2026-07-15T09:00:00.000Z",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 3,
      outputTokens: 1,
      costUsd: 0.1,
      status: "completed",
    });

    const installed = await service.querySessions({
      scope: {
        time: { kind: "all" },
        timeZone: "UTC",
        sessions: { owners: [{ kind: "app", appId: "code-review" }] },
      },
      search: "Code Review",
      page: { offset: 0, limit: 10 },
    });
    const uninstalled = await service.querySessions({
      scope: {
        time: { kind: "all" },
        timeZone: "UTC",
        sessions: { owners: [{ kind: "uninstalled" }] },
      },
      page: { offset: 0, limit: 10 },
    });
    const metrics = await service.queryMetrics({
      scope: { time: { kind: "all" }, timeZone: "UTC" },
      projections: [{ id: "apps", groupBy: "app", interval: "none", rankBy: "cost" }],
    });

    expect(installed.sessions).toEqual([
      expect.objectContaining({
        id: "legacy-agent-session",
        agentName: "code-review-agent",
        owner: expect.objectContaining({ type: "app", id: "code-review", label: "Code Review" }),
      }),
    ]);
    expect(uninstalled.sessions).toEqual([
      expect.objectContaining({
        id: "removed-agent-session",
        owner: expect.objectContaining({ type: "unknown", label: "Uninstalled App" }),
      }),
    ]);
    expect(metrics.projections[0]?.groups).toEqual([
      expect.objectContaining({
        key: "app:code-review",
        usage: expect.objectContaining({ costUsd: 0.25 }),
      }),
      expect.objectContaining({
        key: "app:uninstalled",
        usage: expect.objectContaining({ costUsd: 0.1 }),
      }),
    ]);
  });

  it("applies run filters before computing session rows and their stats", async () => {
    await webchat.ensureRomeSession({
      id: "mixed-model-session",
      type: "action",
      name: "mixed",
      agentName: "code-review-agent",
    });
    await webchat.ensureRomeSession({
      id: "claude-only-session",
      type: "action",
      name: "claude only",
      agentName: "code-review-agent",
    });
    await seedRun({
      messageId: "mixed-gpt",
      sessionId: "mixed-model-session",
      turnId: "mixed-gpt-turn",
      createdAt: "2026-07-15T08:00:00.000Z",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 10,
      outputTokens: 5,
      status: "completed",
    });
    await seedRun({
      messageId: "mixed-claude",
      sessionId: "mixed-model-session",
      turnId: "mixed-claude-turn",
      createdAt: "2026-07-15T09:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      inputTokens: 100,
      outputTokens: 50,
      status: "error",
    });
    await seedRun({
      messageId: "claude-only",
      sessionId: "claude-only-session",
      turnId: "claude-only-turn",
      createdAt: "2026-07-15T10:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4.5",
      inputTokens: 20,
      outputTokens: 10,
      status: "completed",
    });

    const result = await service.querySessions({
      scope: {
        time: { kind: "all" },
        timeZone: "UTC",
        runs: { models: [{ kind: "named", provider: "openai", name: "gpt-5.4" }] },
      },
      sort: { field: "tokens", direction: "desc" },
      page: { offset: 0, limit: 10 },
    });

    expect(result.total).toBe(1);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        id: "mixed-model-session",
        stats: expect.objectContaining({
          runCount: 1,
          usage: expect.objectContaining({ totalTokens: 15 }),
          outcomes: { completed: 1, interrupted: 0, error: 0, unknown: 0 },
        }),
      }),
    ]);
  });

  it("does not label an unattributed project as the long-tail Other group", async () => {
    await webchat.ensureRomeSession({
      id: "unattributed-session",
      type: "action",
      name: "unattributed",
      agentName: "code-review-agent",
      projectPath: null,
    });
    await seedRun({
      messageId: "unattributed-run",
      sessionId: "unattributed-session",
      turnId: "unattributed-turn",
      createdAt: "2026-07-15T08:00:00.000Z",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 10,
      outputTokens: 5,
      status: "completed",
    });

    const result = await service.queryMetrics({
      scope: { time: { kind: "all" }, timeZone: "UTC" },
      projections: [
        {
          id: "projects",
          groupBy: "project",
          interval: "none",
          rankBy: "runs",
        },
      ],
    });

    expect(result.projections[0]?.groups).toEqual([
      expect.objectContaining({
        key: "project:none",
        label: "No project",
        description: null,
        kind: "unknown",
        dimension: { dimension: "project", path: null, label: "No project" },
      }),
    ]);
  });
});

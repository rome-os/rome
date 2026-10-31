import "dotenv/config";
import { eq, like } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { romeAgentMessages, romeAgentTraceBlocks, romeSessions } from "../db/schema.js";

const DEMO_PREFIX = "demo:sessions:";

const profiles = [
  {
    agent: "code-review-expert",
    ownerId: "code-review",
    ownerLabel: "Code Review",
    model: "gpt-5.6-sol",
    provider: "openai",
    type: "action",
  },
  {
    agent: "research-analyst",
    ownerId: "research",
    ownerLabel: "Research",
    model: "claude-opus-4.6",
    provider: "anthropic",
    type: "webchat",
  },
  {
    agent: "support-agent",
    ownerId: "inbox",
    ownerLabel: "Inbox",
    model: "gpt-5.4-mini",
    provider: "openai",
    type: "channel",
  },
  {
    agent: "main",
    ownerId: "core",
    ownerLabel: "Rome",
    model: "gpt-5.5",
    provider: "openai",
    type: "webchat",
  },
  {
    agent: "release-coordinator",
    ownerId: "delivery",
    ownerLabel: "Delivery",
    model: "claude-sonnet-4.5",
    provider: "anthropic",
    type: "subagent",
  },
] as const;

await runMigrations();
const db = getDb();
const repo = new WebChatRepository(db);

const existing = await db
  .select({ id: romeSessions.id })
  .from(romeSessions)
  .where(like(romeSessions.id, `${DEMO_PREFIX}%`));
for (const session of existing) await repo.deleteSession(session.id);

const now = new Date();
let runCount = 0;
for (let index = 0; index < 32; index += 1) {
  const profile = profiles[index % profiles.length];
  const id = `${DEMO_PREFIX}${String(index + 1).padStart(2, "0")}`;
  const daysAgo = index % 14;
  const activityAt = new Date(now.getTime() - daysAgo * 864e5 - (index % 5) * 36e5);
  // The source a demo row reads as; a seat's channel now comes from its chat
  // and account, so the seed stores only its address.
  const source =
    profile.type === "webchat"
      ? "webchat"
      : profile.type === "channel"
        ? index % 2
          ? "email"
          : "feishu"
        : null;
  const triggerName =
    profile.type === "action"
      ? index % 2
        ? "code_review_pr_review"
        : "nightly_quality_scan"
      : null;
  const sessionName =
    profile.type === "action"
      ? `${profile.agent}:${activityAt.getTime()}-${index}`
      : profile.type === "channel"
        ? `Customer thread ${index + 1}`
        : profile.type === "subagent"
          ? `${profile.agent}: Release readiness`
          : index % 3 === 0
            ? "Investigate production latency"
            : `Agent workspace ${index + 1}`;
  await repo.ensureRomeSession({
    id,
    name: sessionName,
    type: profile.type,
    agentName: profile.agent === "main" ? null : profile.agent,
    projectName: index % 2 ? "rome" : "default",
    projectPath: index % 2 ? "rome" : "default",
    sourceThreadId: source ? `thread-${index + 1}` : null,
    sourceThreadName: source ? `Release planning · ${index + 1}` : null,
    sourceThreadType: source ? "group" : null,
    trigger: triggerName
      ? {
          triggerKind: "action",
          triggerName,
          triggerActionName: triggerName,
          triggerExecutionId: `${DEMO_PREFIX}execution:${index + 1}`,
        }
      : undefined,
    parentSessionId: profile.type === "subagent" ? `${DEMO_PREFIX}04` : null,
    parentTurnId: profile.type === "subagent" ? `${DEMO_PREFIX}turn:parent:${index}` : null,
  });
  await db
    .update(romeSessions)
    .set({ createdAt: new Date(activityAt.getTime() - 45 * 60_000), activityAt })
    .where(eq(romeSessions.id, id));

  const runs = 1 + ((index * 7) % 5);
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    runCount += 1;
    const createdAt = new Date(activityAt.getTime() - (runs - runIndex - 1) * 27 * 60_000);
    const inputTokens = 1_400 + ((index * 983 + runIndex * 431) % 12_000);
    const outputTokens = 350 + ((index * 271 + runIndex * 149) % 3_200);
    const cacheReadTokens = (index + runIndex) % 3 === 0 ? 2_000 + index * 110 : 0;
    const cacheWriteTokens = (index + runIndex) % 8 === 0 ? 420 + runIndex * 50 : 0;
    const status = runCount % 13 === 0 ? "error" : runCount % 9 === 0 ? "interrupted" : "completed";
    const hasAccountingGap = runCount % 17 === 0;
    const durationMs = 5_000 + ((index * 5_119 + runIndex * 1_307) % 95_000);
    const costUsd =
      runCount % 11 === 0
        ? null
        : ((inputTokens + outputTokens) / 1_000_000) * (profile.provider === "anthropic" ? 12 : 6);
    const messageId = `${id}:trace:${runIndex + 1}`;
    const turnId = `${id}:turn:${runIndex + 1}`;
    await db.insert(romeAgentMessages).values({
      id: messageId,
      sessionId: id,
      turnId,
      role: "trace",
      content: "[]",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      createdAt,
    });
    const terminalBlock =
      status === "error"
        ? { type: "error", error: "Demo failure" }
        : { type: "result", content: "Demo result" };
    await db.insert(romeAgentTraceBlocks).values([
      {
        messageId,
        seq: 0,
        sessionId: id,
        content: JSON.stringify({
          ...terminalBlock,
          ...(hasAccountingGap
            ? {}
            : {
                accounting: {
                  provider: profile.provider,
                  model: profile.model,
                  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
                  ...(costUsd === null ? {} : { costUsd }),
                },
              }),
        }),
      },
      {
        messageId,
        seq: 1,
        sessionId: id,
        content: JSON.stringify({ type: "turn_end", turnId, status, durationMs }),
      },
    ]);
    if (runIndex === 0) {
      await db.insert(romeAgentMessages).values([
        {
          id: `${id}:user:${runIndex + 1}`,
          sessionId: id,
          turnId: `${id}:turn:${runIndex + 1}`,
          role: "user",
          content: JSON.stringify([
            {
              type: "text",
              content: "Review the latest state and summarize what needs attention.",
            },
          ]),
          createdAt: new Date(createdAt.getTime() - 1_000),
        },
        {
          id: `${id}:assistant:${runIndex + 1}`,
          sessionId: id,
          turnId: `${id}:turn:${runIndex + 1}`,
          role: "assistant",
          content: JSON.stringify([
            {
              type: "text",
              content: "I reviewed the latest state and recorded the result for this demo run.",
            },
          ]),
          createdAt: new Date(createdAt.getTime() + 1_000),
        },
      ]);
    }
  }
}

console.log(
  `Seeded ${existing.length ? "replacement " : ""}${32} demo Sessions with ${runCount} agent runs.`,
);

import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/index.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { WebhookInvocationsRepository } from "../db/repositories/webhook-invocations.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { STRANGER_PERSON_ID } from "../constants.js";
import { GUARDIAN_PROFILE_PATH } from "../profile-memory.js";

/**
 * Unified, deterministic baseline seed.
 *
 * Populates a test DB with "a plausibly populated Rome" — every major domain
 * has a few realistic rows covering the enum/state variants tests commonly
 * branch on. Tests call `seedBaseline(db)` once in `beforeEach`, then make
 * assertions **incrementally** against the ids it returns:
 *
 *   ✓ expect(rows.map(r => r.id)).toContain(baseline.persons.guardianId)
 *   ✗ expect(rows.length).toBe(3)   // fragile — adding one row breaks N tests
 *
 * Specialized state-machine nodes (e.g. a webhook invocation with a FAILED
 * callback) belong in focused helpers below, NOT in the baseline — otherwise
 * the baseline becomes a god-object coupled to every test's assumptions.
 *
 * Patches stay typed: always mutate via repositories, never hand-written SQL.
 * That preserves the schema-drift safety we gained from real Drizzle
 * migrations in `createTestDb()`.
 */

export interface BaselineIds {
  persons: {
    guardianId: string;
    innerCircleId: string;
    acquaintanceId: string;
    otherId: string;
    strangerId: string;
  };
  approvals: {
    pendingId: string;
    approvedId: string;
    rejectedId: string;
    failedExecutionId: string;
  };
  sentinelLog: {
    repliedId: string;
    ignoredKnownId: string;
    unknownSenderId: string;
  };
  webhookInvocations: {
    acceptedId: string;
    succeededWithCallbackId: string;
  };
  actionExecutions: {
    rootSuccessId: string;
    childSuccessId: string;
    rootErrorId: string;
  };
  settings: {
    keys: string[];
  };
}

export async function seedBaseline(db: DrizzleDb): Promise<BaselineIds> {
  const persons = await seedPersonsBaseline(db);
  const approvals = await seedApprovalsBaseline(db);
  const sentinelLog = await seedSentinelLogBaseline(db);
  const webhookInvocations = await seedWebhookInvocationsBaseline(db);
  const actionExecutions = await seedActionExecutionsBaseline(db);
  const settings = await seedSettingsBaseline(db);

  return {
    persons,
    approvals,
    sentinelLog,
    webhookInvocations,
    actionExecutions,
    settings,
  };
}

// Baseline builders (internal — tests should call seedBaseline instead)

async function seedPersonsBaseline(db: DrizzleDb) {
  const repo = new PersonMappingRepository(db);

  const guardianId = "guardian";
  await repo.createWithId(guardianId, {
    displayName: "Guardian",
    bondLevel: "guardian",
    profilePath: GUARDIAN_PROFILE_PATH,
    approved: true,
  });
  await repo.addChannelMapping(guardianId, "telegram", "tg-guardian", "Guardian");
  await repo.addChannelMapping(guardianId, "webchat", "web-guardian", "Guardian");

  const innerCircleId = await repo.create({
    displayName: "Alice Inner",
    bondLevel: "inner-circle",
    approved: true,
    channelMappings: [{ channel: "telegram", channelUserId: "tg-alice" }],
  });

  const acquaintanceId = await repo.create({
    displayName: "Bob Acquaintance",
    bondLevel: "acquaintance",
    approved: true,
    channelMappings: [{ channel: "telegram", channelUserId: "tg-bob" }],
  });

  const otherId = await repo.create({
    displayName: "Carol Other",
    bondLevel: "other",
    approved: true,
    channelMappings: [{ channel: "whatsapp", channelUserId: "wa-carol" }],
  });

  const strangerId = STRANGER_PERSON_ID;
  await repo.createWithId(strangerId, {
    displayName: "Stranger",
    bondLevel: "other",
    approved: true,
  });

  return { guardianId, innerCircleId, acquaintanceId, otherId, strangerId };
}

async function seedApprovalsBaseline(db: DrizzleDb) {
  const repo = new ApprovalsRepository(db);

  const pendingId = await repo.create({
    type: "action_execution",
    requestedBy: "main",
    description: "Send message to Alice",
    payload: { rootExecutionId: "exec-pending-1" },
    status: "pending",
  });

  const approvedId = await repo.create({
    type: "action_execution",
    requestedBy: "main",
    description: "Already approved",
    payload: { rootExecutionId: "exec-approved-1" },
    status: "approved",
  });

  const rejectedId = await repo.create({
    type: "action_execution",
    requestedBy: "main",
    description: "Already rejected",
    payload: { rootExecutionId: "exec-rejected-1" },
    status: "rejected",
  });

  const failedExecutionId = await repo.create({
    type: "action_execution",
    requestedBy: "main",
    description: "Failed execution ready for retry",
    payload: { rootExecutionId: "exec-failed-1" },
    status: "approved",
  });
  await repo.markExecutionFailed(failedExecutionId, "boom");

  return { pendingId, approvedId, rejectedId, failedExecutionId };
}

async function seedSentinelLogBaseline(db: DrizzleDb) {
  const repo = new SentinelLogRepository(db);

  const repliedId = await repo.create({
    messageId: "msg-replied-1",
    channel: "telegram",
    channelUserId: "tg-alice",
    displayName: "Alice Inner",
    threadId: "thread-alice",
    text: "hi",
    action: "replied",
    response: "hello",
  });

  const ignoredKnownId = await repo.create({
    messageId: "msg-ignored-known-1",
    channel: "telegram",
    channelUserId: "tg-alice",
    displayName: "Alice Inner",
    threadId: "thread-alice",
    text: "spam",
    action: "ignored",
  });

  const unknownSenderId = await repo.create({
    messageId: "msg-unknown-1",
    channel: "telegram",
    channelUserId: "tg-stranger-999",
    displayName: "Unknown Stranger",
    threadId: "thread-stranger",
    text: "who are you",
    action: "ignored",
  });

  return { repliedId, ignoredKnownId, unknownSenderId };
}

async function seedWebhookInvocationsBaseline(db: DrizzleDb) {
  const repo = new WebhookInvocationsRepository(db);

  const acceptedId = randomUUID();
  await repo.createAccepted({
    executionId: acceptedId,
    actionName: "send_message",
    args: { to: "guardian", text: "queued" },
    createdAt: new Date("2026-05-01T12:00:00Z"),
  });

  const succeededWithCallbackId = randomUUID();
  await repo.createAccepted({
    executionId: succeededWithCallbackId,
    actionName: "send_message",
    args: { to: "guardian", text: "done" },
    callbackUrl: "https://example.test/cb",
    createdAt: new Date("2026-05-01T12:05:00Z"),
  });
  await repo.update(succeededWithCallbackId, {
    status: "success",
    result: { status: "ok", data: { ok: true } },
    error: null,
    callbackStatus: "succeeded",
    callbackAttemptedAt: new Date("2026-05-01T12:05:01Z"),
    callbackDeliveredAt: new Date("2026-05-01T12:05:01Z"),
    callbackResponseStatus: 200,
    finishedAt: new Date("2026-05-01T12:05:02Z"),
  });

  return { acceptedId, succeededWithCallbackId };
}

async function seedActionExecutionsBaseline(db: DrizzleDb) {
  const repo = new ActionExecutionsRepository(db);

  const rootSuccessId = "root-success";
  await repo.create({
    id: rootSuccessId,
    rootExecutionId: rootSuccessId,
    actionName: "send_message",
    status: "success",
    startedAt: new Date("2026-05-01T10:00:00Z"),
  });

  const childSuccessId = "child-success";
  await repo.create({
    id: childSuccessId,
    rootExecutionId: rootSuccessId,
    actionName: "log_event",
    status: "success",
    startedAt: new Date("2026-05-01T10:00:01Z"),
    parentId: rootSuccessId,
  });

  const rootErrorId = "root-error";
  await repo.create({
    id: rootErrorId,
    rootExecutionId: rootErrorId,
    actionName: "other_action",
    status: "error",
    startedAt: new Date("2026-05-01T11:00:00Z"),
  });

  return { rootSuccessId, childSuccessId, rootErrorId };
}

async function seedSettingsBaseline(db: DrizzleDb) {
  const repo = new SettingsRepository(db);
  await repo.set("timezone", "America/Los_Angeles");
  await repo.set("locale", "en-US");
  return { keys: ["timezone", "locale"] };
}

// Focused extras — state-machine nodes that don't belong in the baseline

/**
 * Seeds a webhook invocation whose callback delivery FAILED.
 * Used by tests that branch on `callbackStatus === "failed"`.
 */
export async function seedFailedCallbackWebhook(db: DrizzleDb): Promise<string> {
  const repo = new WebhookInvocationsRepository(db);
  const executionId = randomUUID();
  await repo.createAccepted({
    executionId,
    actionName: "send_message",
    args: { to: "guardian", text: "fails" },
    callbackUrl: "https://example.test/cb",
    createdAt: new Date("2026-05-01T13:00:00Z"),
  });
  await repo.update(executionId, {
    status: "success",
    result: { status: "ok" },
    callbackStatus: "failed",
    callbackAttemptedAt: new Date("2026-05-01T13:00:01Z"),
    callbackError: "HTTP 502",
    callbackResponseStatus: 502,
    finishedAt: new Date("2026-05-01T13:00:02Z"),
  });
  return executionId;
}

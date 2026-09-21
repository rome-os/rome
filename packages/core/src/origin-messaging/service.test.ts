import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, OriginReference } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import {
  OriginMessagingRepository,
  OriginMessagingService,
  originMessagingInternals,
} from "./service.js";

const APP_ID = "conductor";
const ROUTE = {
  connectionId: "connection:discord:guardian",
  service: "discord",
  conversationId: "dm:guardian",
};

function createHarness(options: { now?: Date; authorized?: boolean } = {}) {
  const testDb = createTestDb();
  let now = options.now ?? new Date("2026-09-19T12:00:00.000Z");
  let available = true;
  const send = rs.fn(async (route: typeof ROUTE, _text: string) => ({
    messageId: "provider-message-1",
    conversationId: route.conversationId as ConversationId,
  }));
  const transport = {
    preflight: rs.fn(async () => (available ? ("available" as const) : ("unavailable" as const))),
    send,
  };
  const service = new OriginMessagingService(
    testDb.db,
    transport,
    (appId) =>
      (options.authorized ?? true) && (appId === APP_ID || appId === "another-first-party-app"),
    () => now,
  );
  return {
    testDb,
    service,
    send,
    setNow(value: Date) {
      now = value;
    },
    setAvailable(value: boolean) {
      available = value;
    },
  };
}

async function capture(service: OriginMessagingService): Promise<OriginReference> {
  const result = await service.capture(APP_ID, ROUTE);
  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error("capture failed");
  return result.origin;
}

describe("OriginMessagingService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.testDb.close();
  });

  it("captures an opaque reference and sends plain text to the exact origin", async () => {
    const origin = await capture(harness.service);

    expect(origin).toMatch(/^or1_[A-Za-z0-9_-]{43}$/);
    expect(origin).not.toContain(ROUTE.connectionId);
    expect(origin).not.toContain(ROUTE.conversationId);

    await expect(
      harness.service.send(APP_ID, {
        origin,
        text: "Action is needed on the Board.",
        idempotencyKey: "asked:42",
      }),
    ).resolves.toEqual({
      status: "accepted",
      deduplicated: false,
      receipt: { messageId: "provider-message-1" },
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith(ROUTE, "Action is needed on the Board.");
  });

  it("isolates references by app and by Rome database instance", async () => {
    const origin = await capture(harness.service);

    await expect(
      harness.service.send("another-first-party-app", {
        origin,
        text: "hello",
        idempotencyKey: "foreign-app",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });

    const other = createHarness();
    try {
      await expect(
        other.service.send(APP_ID, {
          origin,
          text: "hello",
          idempotencyKey: "foreign-instance",
        }),
      ).resolves.toEqual({
        status: "unavailable",
        deduplicated: false,
        reason: "origin_unavailable",
      });
      expect(other.send).not.toHaveBeenCalled();
    } finally {
      other.testDb.close();
    }
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("denies capture and send to non-first-party apps", async () => {
    const denied = createHarness({ authorized: false });
    try {
      await expect(denied.service.capture(APP_ID, ROUTE)).resolves.toEqual({
        status: "unavailable",
        reason: "not_authorized",
      });
      await expect(
        denied.service.send(APP_ID, {
          origin: `or1_${"a".repeat(43)}`,
          text: "hello",
          idempotencyKey: "denied",
        }),
      ).resolves.toEqual({
        status: "unavailable",
        deduplicated: false,
        reason: "origin_unavailable",
      });
      expect(denied.send).not.toHaveBeenCalled();
    } finally {
      denied.testDb.close();
    }
  });

  it("rejects malformed and tampered references without delivery", async () => {
    const origin = await capture(harness.service);
    const tampered = `${origin.slice(0, -1)}${origin.endsWith("a") ? "b" : "a"}`;

    await expect(
      harness.service.send(APP_ID, {
        origin: "discord:connection:dm",
        text: "hello",
        idempotencyKey: "malformed",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });
    await expect(
      harness.service.send(APP_ID, {
        origin: tampered,
        text: "hello",
        idempotencyKey: "tampered",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("fails revoked, expired, missing, and service-mismatched routes without rerouting", async () => {
    const revoked = await capture(harness.service);
    expect(new OriginMessagingRepository(harness.testDb.db).revoke(revoked, APP_ID)).toBe(true);
    await expect(
      harness.service.send(APP_ID, {
        origin: revoked,
        text: "revoked",
        idempotencyKey: "revoked",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });

    const expired = await capture(harness.service);
    harness.setNow(
      new Date(
        new Date("2026-09-19T12:00:00.000Z").getTime() +
          originMessagingInternals.referenceTtlMs +
          1,
      ),
    );
    await expect(
      harness.service.send(APP_ID, {
        origin: expired,
        text: "expired",
        idempotencyKey: "expired",
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });

    harness.setAvailable(false);
    const unavailableHarness = createHarness();
    try {
      const unavailable = await capture(unavailableHarness.service);
      unavailableHarness.setAvailable(false);
      await expect(
        unavailableHarness.service.send(APP_ID, {
          origin: unavailable,
          text: "unavailable",
          idempotencyKey: "unavailable",
        }),
      ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });

      unavailableHarness.setAvailable(false);
      await expect(
        unavailableHarness.service.send(APP_ID, {
          origin: unavailable,
          text: "mismatch",
          idempotencyKey: "mismatch",
        }),
      ).resolves.toMatchObject({ status: "unavailable", reason: "origin_unavailable" });
      expect(unavailableHarness.send).not.toHaveBeenCalled();
    } finally {
      unavailableHarness.testDb.close();
    }
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("deduplicates accepted sends and rejects key reuse for another payload", async () => {
    const origin = await capture(harness.service);
    const input = { origin, text: "hello", idempotencyKey: "same-key" };

    await expect(harness.service.send(APP_ID, input)).resolves.toMatchObject({
      status: "accepted",
      deduplicated: false,
    });
    await expect(harness.service.send(APP_ID, input)).resolves.toMatchObject({
      status: "accepted",
      deduplicated: true,
    });
    await expect(harness.service.send(APP_ID, { ...input, text: "different" })).resolves.toEqual({
      status: "invalid_request",
      deduplicated: false,
      reason: "idempotency_conflict",
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it("scopes an idempotency key to the captured origin", async () => {
    const first = await capture(harness.service);
    const second = await capture(harness.service);

    await expect(
      harness.service.send(APP_ID, { origin: first, text: "first", idempotencyKey: "same-key" }),
    ).resolves.toMatchObject({ status: "accepted", deduplicated: false });
    await expect(
      harness.service.send(APP_ID, { origin: second, text: "second", idempotencyKey: "same-key" }),
    ).resolves.toMatchObject({ status: "accepted", deduplicated: false });
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it("does not expose provider route coordinates or extra receipt fields", async () => {
    const origin = await capture(harness.service);
    harness.send.mockResolvedValueOnce({
      messageId: "m-1",
      conversationId: ROUTE.conversationId as ConversationId,
      connectionId: ROUTE.connectionId,
      parts: [
        {
          messageId: "part-1",
          kind: "text",
          conversationId: ROUTE.conversationId,
        },
      ],
    } as never);

    const result = await harness.service.send(APP_ID, {
      origin,
      text: "hello",
      idempotencyKey: "sanitized",
    });
    expect(result).toEqual({
      status: "accepted",
      deduplicated: false,
      receipt: { messageId: "m-1", parts: [{ messageId: "part-1", kind: "text" }] },
    });
    expect(JSON.stringify(result)).not.toContain("connection");
    expect(JSON.stringify(result)).not.toContain("conversation");
  });

  it("prunes expired routes and attempts after their bounded retention window", async () => {
    const origin = await capture(harness.service);
    await harness.service.send(APP_ID, {
      origin,
      text: "hello",
      idempotencyKey: "old-attempt",
    });
    const repository = new OriginMessagingRepository(harness.testDb.db);

    harness.setNow(
      new Date(
        new Date("2026-09-19T12:00:00.000Z").getTime() +
          originMessagingInternals.attemptRetentionMs +
          originMessagingInternals.routeRetentionMs +
          1,
      ),
    );
    repository.prune(
      new Date(
        new Date("2026-09-19T12:00:00.000Z").getTime() +
          originMessagingInternals.attemptRetentionMs +
          originMessagingInternals.routeRetentionMs +
          1,
      ),
    );

    expect(repository.findRoute(origin, APP_ID)).toBeNull();
    await expect(
      harness.service.send(APP_ID, {
        origin,
        text: "hello",
        idempotencyKey: "old-attempt",
      }),
    ).resolves.toMatchObject({ status: "unavailable", deduplicated: false });
  });

  it("persists an indeterminate send and never automatically retries it", async () => {
    const origin = await capture(harness.service);
    harness.send.mockImplementation(async () => {
      throw new Error("provider timed out after accepting");
    });
    const input = { origin, text: "hello", idempotencyKey: "uncertain" };

    await expect(harness.service.send(APP_ID, input)).resolves.toEqual({
      status: "indeterminate",
      deduplicated: false,
    });
    await expect(harness.service.send(APP_ID, input)).resolves.toEqual({
      status: "indeterminate",
      deduplicated: true,
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});

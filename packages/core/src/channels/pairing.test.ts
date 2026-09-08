import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, InboundMessage, TalkRouter } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { approvals, persons, channelMappings } from "../db/schema.js";
import { pairingPayload } from "@rome/api-types/approvals";
import { createPairingAdmission } from "./pairing.js";
import { eq } from "drizzle-orm";

describe("channel pairing approvals", () => {
  let testDb: TestDb;
  let repo: ApprovalsRepository;
  const key = Buffer.alloc(32, 7);
  const identity = {
    channel: "telegram" as const,
    connectionId: "connection:telegram",
    channelUserId: "alice",
    displayName: "Alice",
  };
  beforeEach(() => {
    testDb = createTestDb();
    repo = new ApprovalsRepository(testDb.db, () => key);
    testDb.db
      .insert(persons)
      .values({ id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() })
      .run();
  });
  afterEach(() => testDb.close());

  it("reuses a pending identity, limits guidance, and retains codes across repository restarts", async () => {
    const first = repo.requestPairing(identity)!;
    const second = repo.requestPairing(identity)!;
    expect(second.approval.id).toBe(first.approval.id);
    expect(second.guide).toBe(false);
    expect((await repo.list()).length).toBe(1);
    const code = await repo.pairingCode(first.approval.id);
    expect(code).toMatch(/^ROME-PAIR-[0-9A-F]{20}$/);
    expect(await new ApprovalsRepository(testDb.db, () => key).pairingCode(first.approval.id)).toBe(
      code,
    );
    expect(JSON.stringify(await repo.list())).not.toContain(code);
  });

  it("rejects cross-identity, cross-channel, cross-connection and replayed codes", async () => {
    const request = repo.requestPairing(identity)!;
    const code = (await repo.pairingCode(request.approval.id))!;
    for (const changed of [
      { channelUserId: "mallory" },
      { channel: "discord" },
      { connectionId: "another" },
    ]) {
      expect(repo.verifyPairing({ ...identity, ...changed, code }).outcome).toBe("invalid_code");
    }
    expect(repo.verifyPairing({ ...identity, code })).toMatchObject({
      outcome: "resolved",
      approval: { status: "approved", resolvedBy: "telegram:alice" },
    });
    expect(repo.verifyPairing({ ...identity, code }).outcome).toBe("invalid_code");
    expect(testDb.db.select().from(channelMappings).all()).toHaveLength(1);
    expect(await repo.pairingCode(request.approval.id)).toBeNull();
  });

  it("locks code verification after five failures while retaining Web approval", async () => {
    const id = repo.requestPairing(identity)!.approval.id;
    const code = (await repo.pairingCode(id))!;
    for (let i = 0; i < 5; i++) repo.verifyPairing({ ...identity, code: "ROME-PAIR-wrong" });
    expect(repo.verifyPairing({ ...identity, code }).outcome).toBe("invalid_code");
    expect(await repo.pairingCode(id)).toBeNull();
    expect(await repo.resolvePending(id, "approve", "owner-session")).toMatchObject({
      outcome: "resolved",
      approval: { status: "approved" },
    });
  });

  it("expires and rejects once, without regenerating a rejected request during its lifetime", async () => {
    const id = repo.requestPairing(identity)!.approval.id;
    await repo.resolvePending(id, "reject", "owner-session");
    expect(repo.requestPairing(identity)).toBeNull();
    expect(repo.verifyPairing({ ...identity, code: "ROME-PAIR-wrong" }).outcome).toBe(
      "invalid_code",
    );
    const other = repo.requestPairing(
      { ...identity, channelUserId: "bob" },
      Date.now() - 11 * 60_000,
    )!;
    expect(await repo.resolvePending(other.approval.id, "approve", "owner-session")).toMatchObject({
      outcome: "already_resolved",
      approval: { status: "rejected", resolvedBy: "system:expiry" },
    });
    expect(testDb.db.select().from(channelMappings).all()).toHaveLength(0);
  });

  it("allows only one winner between Web and code, preserving the resolver", async () => {
    const id = repo.requestPairing(identity)!.approval.id;
    const code = (await repo.pairingCode(id))!;
    const web = repo.resolvePending(id, "approve", "owner-session");
    const verification = repo.verifyPairing({ ...identity, code });
    await web;
    expect(verification.outcome).toBe("resolved");
    expect((await repo.findById(id))?.resolvedBy).toBe("telegram:alice");
    expect(testDb.db.select().from(channelMappings).all()).toHaveLength(1);
  });

  it("rolls back approval and mapping together and refuses to transfer an existing account", async () => {
    const id = repo.requestPairing(identity)!.approval.id;
    testDb.db.run(
      `CREATE TRIGGER fail_pairing BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'write failed'); END`,
    );
    await expect(repo.resolvePending(id, "approve", "owner-session")).rejects.toThrow();
    expect(testDb.db.select().from(channelMappings).all()).toHaveLength(0);
    expect(testDb.db.select().from(approvals).where(eq(approvals.id, id)).get()?.status).toBe(
      "pending",
    );
    testDb.db.run("DROP TRIGGER fail_pairing");
    testDb.db
      .insert(channelMappings)
      .values({ id: "held", personId: "owner", channel: "telegram", channelUserId: "alice" })
      .run();
    const result = await repo.resolvePending(id, "approve", "owner-session");
    expect(result).toMatchObject({ outcome: "resolved", approval: { status: "rejected" } });
    expect(pairingPayload((await repo.findById(id))!)?.resolution).toBe("account_linked");
  });

  it.each([
    "telegram",
    "discord",
    "feishu",
  ])("blocks unknown %s messages and consumes group and replayed verification", async (service) => {
    const admit = createPairingAdmission({
      approvalsRepo: repo,
      personMappingRepo: new PersonMappingRepository(testDb.db),
    });
    const send = rs.fn<TalkRouter["send"]>(async () => ({
      messageId: "sent",
      conversationId: "dm" as ConversationId,
    }));
    const router = { send } as unknown as TalkRouter;
    const message: InboundMessage = {
      senderId: "alice",
      senderDisplayName: "Owner",
      conversationId: "dm" as ConversationId,
      messageId: "one",
      text: "hello",
      attachments: [],
      timestamp: new Date(),
      thread: { kind: "dm" },
    };
    expect(await admit("connection", service, message, router)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await admit("connection", service, message, router)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const request = (await repo.findPending())[0];
    const code = (await repo.pairingCode(request.id))!;
    expect(
      await admit(
        "connection",
        service,
        { ...message, text: code, thread: { kind: "group" } },
        router,
      ),
    ).toBe(false);
    expect((await repo.findById(request.id))?.status).toBe("pending");
    expect(await admit("connection", service, { ...message, text: code }, router)).toBe(false);
    expect(await admit("connection", service, { ...message, text: code }, router)).toBe(false);
    expect(await admit("connection", service, message, router)).toBe(true);
    expect(send.mock.calls.some(([, , body]) => body.text?.includes(code))).toBe(false);
  });
});

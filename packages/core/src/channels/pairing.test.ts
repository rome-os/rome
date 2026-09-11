import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, InboundMessage, TalkRouter } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { approvals, persons, channelMappings } from "../db/schema.js";
import { pairingPayload } from "@rome/api-types/approvals";
import { createPairingAdmission, notifyPairingResolution } from "./pairing.js";
import { eq } from "drizzle-orm";
import { STRANGER_PERSON_ID } from "../constants.js";

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

  it.each([
    "telegram",
    "discord",
    "feishu",
  ] as const)("%s privately notifies a group requester after Web approval without undoing approval on delivery failure", async (channel) => {
    const id = channel === "feishu" ? "ou_123" : "123";
    const account =
      channel === "telegram"
        ? "@actualuser (`123`)"
        : channel === "discord"
          ? "<@123> (`123`)"
          : '<at user_id="ou_123">ou_123</at> (`ou_123`)';
    const send = rs.fn<TalkRouter["send"]>(async (_connection, conversationId) => ({
      messageId: "sent",
      conversationId,
    }));
    const conversationFor = rs.fn(async () => "private-chat" as ConversationId);
    const feature = rs.fn(() => ({ conversationFor }));
    const router = { send, feature } as unknown as TalkRouter;
    const admit = createPairingAdmission({
      approvalsRepo: repo,
      personMappingRepo: new PersonMappingRepository(testDb.db),
    });
    await admit(
      "connection",
      channel,
      {
        senderId: id,
        senderUsername: channel === "telegram" ? "actualuser" : undefined,
        conversationId: "group" as ConversationId,
        messageId: "request",
        text: "hello",
        attachments: [],
        timestamp: new Date(),
        thread: { kind: "group" },
        addressing: "mention",
      },
      router,
    );
    const request = (await repo.findPending())[0];
    expect(pairingPayload(request)?.conversationId).toBeUndefined();
    const result = await repo.resolvePending(request.id, "approve", "owner");
    if (result.outcome !== "resolved") throw new Error("Approval failed");
    send.mockClear();
    await notifyPairingResolution(router, result.approval);
    expect(feature).toHaveBeenCalledWith("connection", "directMessaging");
    expect(conversationFor).toHaveBeenCalledWith(id);
    expect(send).toHaveBeenCalledWith("connection", "private-chat", {
      text: `✅ ${account} is paired with Rome. You can start chatting now.`,
    });
    send.mockRejectedValueOnce(new Error("Private messages disabled"));
    await expect(notifyPairingResolution(router, result.approval)).resolves.toBeUndefined();
    expect((await repo.findById(request.id))?.status).toBe("approved");
    expect(testDb.db.select().from(channelMappings).all()).toHaveLength(1);
  });

  it.each([
    ["telegram", "123", "Alice [Smith]", "[@Alice \\[Smith\\]](tg://user?id=123) (`123`)"],
    ["discord", "123", "@everyone", "<@123> (`123`)"],
    [
      "feishu",
      "ou_123",
      "Alice <at>&",
      '<at user_id="ou_123">Alice &lt;at&gt;&amp;</at> (`ou_123`)',
    ],
  ])("%s mentions only the requester even with special characters in their name", async (channel, id, name, expected) => {
    const send = rs.fn<TalkRouter["send"]>(async () => ({
      messageId: "sent",
      conversationId: "dm" as ConversationId,
    }));
    await createPairingAdmission({
      approvalsRepo: repo,
      personMappingRepo: new PersonMappingRepository(testDb.db),
    })(
      "connection",
      channel,
      {
        senderId: id,
        senderDisplayName: name,
        conversationId: "dm" as ConversationId,
        messageId: "request",
        text: "hello",
        attachments: [],
        timestamp: new Date(),
        thread: { kind: "dm" },
      },
      { send } as unknown as TalkRouter,
    );
    expect(send.mock.calls[0][2].text).toContain(`Pair ${expected} with Rome.`);
  });

  it("reuses a pending identity, limits guidance, and retains codes across repository restarts", async () => {
    const first = repo.requestPairing(identity)!;
    const second = repo.requestPairing({ ...identity, username: "current_handle" })!;
    expect(second.approval.id).toBe(first.approval.id);
    expect(second.guide).toBe(false);
    expect(second.approval.payload).toMatchObject({ username: "current_handle" });
    expect((await repo.list()).length).toBe(1);
    const code = await repo.pairingCode(first.approval.id);
    expect(code).toMatch(/^RP-[0-9A-F]{8}$/);
    expect(await new ApprovalsRepository(testDb.db, () => key).pairingCode(first.approval.id)).toBe(
      code,
    );
    expect(JSON.stringify(await repo.list())).not.toContain(code);
  });

  it("refreshes a reused Feishu request name for display and Web approval notification", async () => {
    const input = { ...identity, channel: "feishu" as const, channelUserId: "ou_123" };
    const now = Date.now();
    const first = repo.requestPairing({ ...input, displayName: "Feishu User" }, now)!;
    const code = await repo.pairingCode(first.approval.id);
    const second = repo.requestPairing({ ...input, displayName: " Alice " }, now + 1_000)!;
    expect(second.approval.id).toBe(first.approval.id);
    expect(second.guide).toBe(false);
    expect(pairingPayload((await repo.findById(first.approval.id))!)).toMatchObject({
      displayName: "Alice",
      expiresAt: now + 10 * 60_000,
      failedAttempts: 0,
      lastGuidanceAt: now,
    });
    expect(await repo.pairingCode(first.approval.id)).toBe(code);
    const result = await repo.resolvePending(first.approval.id, "approve", "owner");
    if (result.outcome !== "resolved") throw new Error("Approval failed");
    const send = rs.fn<TalkRouter["send"]>(async () => ({
      messageId: "sent",
      conversationId: "dm" as ConversationId,
    }));
    const router = {
      send,
      feature: () => ({ conversationFor: async () => "dm" as ConversationId }),
    } as unknown as TalkRouter;
    await notifyPairingResolution(router, result.approval);
    expect(send).toHaveBeenCalledWith(input.connectionId, "dm", {
      text: '✅ <at user_id="ou_123">Alice</at> (`ou_123`) is paired with Rome. You can start chatting now.',
    });
  });

  it.each([
    "",
    "   ",
    "ou_123",
    "Feishu User",
  ])("preserves a known name when a reused request supplies %j", async (displayName) => {
    const input = { ...identity, channel: "feishu" as const, channelUserId: "ou_123" };
    const first = repo.requestPairing(input)!;
    repo.requestPairing({ ...input, displayName })!;
    expect(pairingPayload((await repo.findById(first.approval.id))!)?.displayName).toBe("Alice");
  });

  it("refreshes a known name when the requesting account is renamed", async () => {
    const first = repo.requestPairing(identity)!;
    repo.requestPairing({ ...identity, displayName: "Alice Smith" });
    expect(pairingPayload((await repo.findById(first.approval.id))!)?.displayName).toBe(
      "Alice Smith",
    );
  });

  it.each([
    "telegram",
    "discord",
    "feishu",
  ] as const)("%s requires dismissed accounts to pair before admission", async (channel) => {
    const people = new PersonMappingRepository(testDb.db);
    testDb.db
      .insert(persons)
      .values({
        id: STRANGER_PERSON_ID,
        displayName: "Stranger",
        bondLevel: "other",
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    await people.addChannelMapping(STRANGER_PERSON_ID, channel, "dismissed", "Alice");
    const admit = createPairingAdmission({ approvalsRepo: repo, personMappingRepo: people });
    const send = rs.fn<TalkRouter["send"]>(async () => ({
      messageId: "sent",
      conversationId: "dm" as ConversationId,
    }));
    const router = { send } as unknown as TalkRouter;
    const message: InboundMessage = {
      senderId: "dismissed",
      senderDisplayName: "Alice",
      conversationId: "dm" as ConversationId,
      messageId: "request",
      text: "hello",
      attachments: [],
      timestamp: new Date(),
      thread: { kind: "dm" },
    };
    expect(await admit("connection", channel, message, router)).toBe(false);
    const request = (await repo.findPending())[0];
    expect(request).toBeDefined();
    expect((await people.findByChannelUser(channel, "dismissed"))?.id).toBe(STRANGER_PERSON_ID);
    expect(await admit("connection", channel, message, router)).toBe(false);
    expect(await repo.findPending()).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    testDb.db.run(
      "CREATE TRIGGER fail_dismissed_pairing BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'approval failed'); END",
    );
    await expect(repo.resolvePending(request.id, "approve", "owner")).rejects.toThrow();
    testDb.db.run("DROP TRIGGER fail_dismissed_pairing");
    expect((await repo.findById(request.id))?.status).toBe("pending");
    expect((await people.findByChannelUser(channel, "dismissed"))?.id).toBe(STRANGER_PERSON_ID);
    if (channel === "discord") {
      const code = (await repo.pairingCode(request.id))!;
      expect(
        repo.verifyPairing({
          connectionId: "connection",
          channel,
          channelUserId: "dismissed",
          code,
        }).outcome,
      ).toBe("resolved");
    } else {
      expect((await repo.resolvePending(request.id, "approve", "owner")).outcome).toBe("resolved");
    }
    expect((await people.findByChannelUser(channel, "dismissed"))?.id).toBe("owner");
    expect(await admit("connection", channel, message, router)).toBe(true);
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

  it("loads a key once per repository and accepts mixed-case codes without consuming attempts", async () => {
    const load = rs.fn(() => key);
    const cached = new ApprovalsRepository(testDb.db, load);
    const id = cached.requestPairing(identity)!.approval.id;
    const code = (await cached.pairingCode(id))!;
    expect(await cached.pairingCode(id)).toBe(code);
    expect(cached.verifyPairing({ ...identity, code: code.toLowerCase() })).toMatchObject({
      outcome: "resolved",
      approval: { status: "approved" },
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(pairingPayload((await cached.findById(id))!)?.failedAttempts).toBe(0);
  });

  it("replaces a removed connection's pending request while retaining rejection cooldown", async () => {
    const old = repo.requestPairing(identity)!.approval.id;
    const oldCode = (await repo.pairingCode(old))!;
    const replacement = { ...identity, connectionId: "replacement" };
    const next = repo.requestPairing(replacement)!;
    expect(next.guide).toBe(true);
    expect(next.approval.id).not.toBe(old);
    expect(pairingPayload((await repo.findById(old))!)?.resolution).toBe("superseded");
    expect(repo.requestPairing(replacement)!.approval.id).toBe(next.approval.id);
    expect(await repo.findPending()).toHaveLength(1);
    expect(repo.verifyPairing({ ...identity, code: oldCode }).outcome).toBe("invalid_code");
    expect(repo.verifyPairing({ ...replacement, code: oldCode }).outcome).toBe("invalid_code");
    await repo.resolvePending(next.approval.id, "reject", "owner-session");
    expect(repo.requestPairing({ ...identity, connectionId: "third" })).toBeNull();
  });

  it("caps pending and rolling daily requests per connection, while allowing existing requests to complete", async () => {
    for (let n = 0; n < 20; n++)
      expect(repo.requestPairing({ ...identity, channelUserId: `user-${n}` })).not.toBeNull();
    expect(repo.requestPairing({ ...identity, channelUserId: "overflow" })).toBeNull();
    expect(repo.requestPairing({ ...identity, channelUserId: "user-0" })).not.toBeNull();
    for (const row of await repo.findPending())
      await repo.resolvePending(row.id, "reject", "owner-session");
    for (let n = 20; n < 100; n++) {
      const row = repo.requestPairing({ ...identity, channelUserId: `user-${n}` })!;
      await repo.resolvePending(row.approval.id, "reject", "owner-session");
    }
    expect(repo.requestPairing({ ...identity, channelUserId: "daily-overflow" })).toBeNull();
    expect(
      repo.requestPairing({ ...identity, connectionId: "other", channelUserId: "other" }),
    ).not.toBeNull();
    expect(
      repo.requestPairing({ ...identity, channelUserId: "tomorrow" }, Date.now() + 86_401_000),
    ).not.toBeNull();
  });

  it("pages pairing history without losing pending requests or deleting audit rows", async () => {
    for (let n = 0; n < 105; n++)
      await repo.create({
        type: "person_mapping",
        status: "rejected",
        requestedBy: "test",
        description: "historical",
        payload: {
          ...identity,
          connectionId: "historical",
          action: "channel_pairing",
          expiresAt: 0,
          failedAttempts: 0,
          lastGuidanceAt: 0,
        },
      });
    const pending = repo.requestPairing(identity)!.approval.id;
    const nonPairing = await repo.create({
      type: "action_execution",
      status: "approved",
      requestedBy: "test",
      description: "normal",
    });
    const first = await repo.list();
    expect(first).toHaveLength(102);
    expect(first.some((row) => row.id === pending)).toBe(true);
    expect(first.some((row) => row.id === nonPairing)).toBe(true);
    const second = await repo.list(undefined, 100);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(107);
    expect(testDb.db.select().from(approvals).all()).toHaveLength(107);
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
    const id = service === "feishu" ? "ou_123" : "123";
    const account =
      service === "telegram"
        ? "@realowner (`123`)"
        : service === "discord"
          ? "<@123> (`123`)"
          : '<at user_id="ou_123">Owner</at> (`ou_123`)';
    const message: InboundMessage = {
      senderId: id,
      senderDisplayName: "Owner",
      senderUsername: service === "telegram" ? "realowner" : undefined,
      conversationId: "dm" as ConversationId,
      messageId: "one",
      text: "hello",
      attachments: [],
      timestamp: new Date(),
      thread: { kind: "dm" },
    };
    const group = { ...message, thread: { kind: "group" as const } };
    expect(await admit("connection", service, { ...group, addressing: "ambient" }, router)).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
    expect(await repo.findPending()).toHaveLength(0);
    if (service === "telegram") {
      expect(
        await admit(
          "connection",
          service,
          { ...group, senderId: "-100123", text: "ROME-PAIR-code" },
          router,
        ),
      ).toBe(false);
      expect(await repo.findPending()).toHaveLength(0);
    }
    expect(await admit("connection", service, { ...group, addressing: "mention" }, router)).toBe(
      false,
    );
    expect(await admit("connection", service, message, router)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2].text).toContain(`🔗 Pair ${account} with Rome.`);
    expect(send.mock.calls[0][2].text).toContain(
      `Learn more in the [Pairing Guide](https://romeos.cc/docs/rome/${service === "feishu" ? "lark" : service}).`,
    );
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
    expect(
      await admit("connection", service, { ...message, text: code.toLowerCase() }, router),
    ).toBe(false);
    expect(await admit("connection", service, { ...message, text: code }, router)).toBe(false);
    expect(await admit("connection", service, message, router)).toBe(true);
    expect(
      send.mock.calls.some(
        ([, , body]) =>
          body.text === `✅ ${account} is paired with Rome. You can start chatting now.`,
      ),
    ).toBe(true);
    expect(send.mock.calls.some(([, , body]) => body.text?.includes(code))).toBe(false);
  });
});

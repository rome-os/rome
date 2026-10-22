import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { MailProvider } from "../lib/rome-cloud-mail.js";
import { createTestDb, identityConnectionKindOf, type TestDb } from "../test/helpers.js";
import { STRANGER_PERSON_ID } from "../constants.js";
import { persons } from "../db/schema.js";
import { EmailAdapter } from "./email.js";
import { createGuardianLinkAdmission, GuardianLinkCodes } from "./guardian-link-code.js";

function message(text: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "telegram",
    direction: "inbound",
    messageId: "m1",
    chatId: "dm" as ChatId,
    senderId: "123",
    text,
    attachments: [],
    timestamp: new Date(0),
    thread: { kind: "dm" },
    ...overrides,
  } as ChannelMessage;
}

describe("GuardianLinkCodes", () => {
  it("uses a code once, case-insensitively", () => {
    const codes = new GuardianLinkCodes();
    const { code } = codes.issue();
    expect(code).toMatch(/^ROME-[A-Z2-9]{8}$/);
    expect(codes.redeem(` ${code.toLowerCase()} `)).toBe(true);
    expect(codes.redeem(code)).toBe(false);
  });

  it("voids a code when a new one is shown, when it expires, and after five wrong codes", () => {
    let now = 0;
    const codes = new GuardianLinkCodes(() => now);
    const first = codes.issue().code;
    const second = codes.issue().code;
    expect(codes.redeem(first)).toBe(first === second);

    const expiring = codes.issue();
    now = expiring.expiresAt;
    expect(codes.redeem(expiring.code)).toBe(false);

    const guessed = codes.issue().code;
    for (let i = 0; i < 5; i++) codes.redeem("ROME-AAAAAAAA");
    expect(codes.redeem(guessed)).toBe(false);
  });
});

describe("guardian link admission", () => {
  let testDb: TestDb;
  let repo: PersonMappingRepository;
  let codes: GuardianLinkCodes;
  let send: ReturnType<typeof rs.fn>;
  let admit: ReturnType<typeof createGuardianLinkAdmission>;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new PersonMappingRepository(testDb.db, identityConnectionKindOf);
    testDb.db
      .insert(persons)
      .values([
        { id: "owner", displayName: "Owner", bondLevel: "guardian", createdAt: new Date() },
        { id: "li", displayName: "Li", bondLevel: "acquaintance", createdAt: new Date() },
        {
          id: STRANGER_PERSON_ID,
          displayName: "Stranger",
          bondLevel: "other",
          createdAt: new Date(),
        },
      ])
      .run();
    codes = new GuardianLinkCodes();
    send = rs.fn(async (chatId: ChatId) => ({ messageId: "sent", chatId }));
    const registry = {
      get: () => ({ withTalker: (call: (talker: object) => unknown) => call({ send }) }),
    } as unknown as Pick<ConnectionRegistry, "get">;
    admit = createGuardianLinkAdmission({ codes, personMappingRepo: repo, registry });
  });
  afterEach(() => testDb.close());

  it("admits every message that is not a code, from a stranger too", async () => {
    expect(await admit("bot", "telegram", message("hello"))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("links the sender of a code in a direct message to the guardian, anywhere", async () => {
    const { code } = codes.issue();
    expect(await admit("bot", "discord", message(code, { channel: "discord" }))).toBe(false);
    expect((await repo.findByChannelUser("discord", "123"))?.id).toBe("owner");
    await rs.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    expect(await admit("wa", "whatsapp", message(codes.issue().code, { senderId: "8613" }))).toBe(
      false,
    );
    expect((await repo.findByChannelUser("whatsapp", "8613"))?.id).toBe("owner");
  });

  it("links a dismissed account, and refuses to move one linked to someone else", async () => {
    await repo.addChannelMapping(STRANGER_PERSON_ID, "telegram", "123");
    expect(await admit("bot", "telegram", message(codes.issue().code))).toBe(false);
    expect((await repo.findByChannelUser("telegram", "123"))?.id).toBe("owner");

    await repo.addChannelMapping("li", "telegram", "456");
    expect(await admit("bot", "telegram", message(codes.issue().code, { senderId: "456" }))).toBe(
      false,
    );
    expect((await repo.findByChannelUser("telegram", "456"))?.id).toBe("li");
  });

  it("leaves the code unused when it comes in mail that failed authentication", async () => {
    const { code } = codes.issue();
    const inbound: ChannelMessage[] = [];
    const mail = new EmailAdapter({
      provider: {
        getMessage: async () => {
          throw new Error("body unavailable");
        },
      } as unknown as MailProvider,
      settingsRepo: {} as unknown as SettingsRepository,
      personMappingRepo: repo,
      config: { address: "slug@mail.romeos.cc", inboundSecret: "secret" },
    });
    mail.onInbound(async (m) => {
      inbound.push(m);
    });
    const raw = JSON.stringify({
      type: "message.received",
      provider: "agentmail",
      mailboxAddress: "slug@mail.romeos.cc",
      id: "evt_1",
      providerMessageId: "msg_1",
      threadId: "t1",
      from: [{ name: "Owner", email: "owner@example.com" }],
      to: [{ email: "slug@mail.romeos.cc" }],
      subject: "code",
      preview: code,
      receivedAt: new Date(0).toISOString(),
      hasAttachment: false,
      attachments: [],
      authentication: { authenticated: false, spam: false, blocked: false },
      labels: ["received", "unread", "unauthenticated"],
    });
    await mail.ingestInbound(raw, createHmac("sha256", "secret").update(raw).digest("hex"));

    expect(await admit("mail", "email", inbound[0])).toBe(false);
    expect(await repo.findByChannelUser("email", inbound[0].senderId)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(codes.redeem(code)).toBe(true);
  });

  it("voids a code said in a group without linking anyone", async () => {
    const { code } = codes.issue();
    expect(await admit("bot", "feishu", message(code, { thread: { kind: "group" } }))).toBe(false);
    expect(await repo.findByChannelUser("feishu", "123")).toBeNull();
    expect(await admit("bot", "feishu", message(code))).toBe(false);
    expect(await repo.findByChannelUser("feishu", "123")).toBeNull();
  });

  it("keeps a wrong code out of the chat and links no one", async () => {
    codes.issue();
    expect(await admit("bot", "slack_bot", message("ROME-AAAAAAAA"))).toBe(false);
    expect(await repo.findByChannelUser("slack_bot", "123")).toBeNull();
    await rs.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

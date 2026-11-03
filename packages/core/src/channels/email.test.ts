import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import { EmailAdapter, type EmailInboxCoordinates } from "./email.js";
import type {
  MailProvider,
  RomeMailEvent,
  RomeMailMessage,
  SendMailInput,
  SendMailResult,
} from "../lib/rome-cloud-mail.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { PeopleRepository } from "../db/repositories/people.js";

const INBOUND_SECRET = "test-inbound-secret";
const GUARDIAN = "guardian@example.com";

function makeProvider(overrides: Partial<MailProvider> = {}): MailProvider & {
  sent: SendMailInput[];
} {
  const sent: SendMailInput[] = [];
  return {
    sent,
    provision: rs.fn(async () => ({
      address: "slug@mail.romeos.cc",
      inboundSecret: INBOUND_SECRET,
    })),
    send: rs.fn(async (input: SendMailInput): Promise<SendMailResult> => {
      sent.push(input);
      return { messageId: "m_out", threadId: "t_out" };
    }),
    getMessage: rs.fn(
      async (messageId: string): Promise<RomeMailMessage> => ({
        id: messageId,
        threadId: "t1",
        receivedAt: new Date(0).toISOString(),
        body: { markdown: "hello from the full body" },
        attachments: [],
        hasAttachment: false,
        provider: "agentmail",
        providerMessageId: messageId,
        mailboxAddress: "slug@mail.romeos.cc",
        direction: "inbound",
        authentication: { authenticated: true, spam: false, blocked: false },
        labels: [],
      }),
    ),
    getAttachment: rs.fn(async () => ({
      downloadUrl: "https://example.com/x",
      expiresAt: new Date(0).toISOString(),
      size: 0,
    })),
    listMessages: rs.fn(async () => ({ messages: [], nextPageToken: undefined })),
    ...overrides,
  };
}

function makeAdapter(
  provider: MailProvider,
  config?: Partial<EmailInboxCoordinates>,
): EmailAdapter {
  return new EmailAdapter({
    provider,
    settingsRepo: {} as unknown as SettingsRepository,
    peopleRepo: {} as unknown as PeopleRepository,
    // The adapter runs on the provisioned coordinates (the `inbox` grant
    // material); guardianEmail is durable settings config, sourced in start().
    config: {
      address: "slug@mail.romeos.cc",
      inboundSecret: INBOUND_SECRET,
      ...config,
    },
  });
}

function buildEvent(overrides: Partial<RomeMailEvent> = {}): RomeMailEvent {
  return {
    type: "message.received",
    provider: "agentmail",
    mailboxAddress: "slug@mail.romeos.cc",
    id: "evt_1",
    providerMessageId: "msg_1",
    threadId: "t1",
    from: [{ name: "Guardian", email: GUARDIAN }],
    to: [{ email: "slug@mail.romeos.cc" }],
    subject: "Hi",
    preview: "preview text",
    receivedAt: new Date(0).toISOString(),
    hasAttachment: false,
    attachments: [],
    authentication: { authenticated: true, spam: false, blocked: false },
    labels: ["received", "unread"],
    ...overrides,
  };
}

function sign(rawBody: string): string {
  return createHmac("sha256", INBOUND_SECRET).update(rawBody).digest("hex");
}

describe("EmailAdapter.ingestInbound", () => {
  it("dispatches an authenticated guardian email on the trusted identity", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    const raw = JSON.stringify(buildEvent());
    const result = await adapter.ingestInbound(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(received).toEqual([
      {
        channel: "email",
        direction: "inbound",
        messageId: "msg_1",
        chatId: "t1",
        senderId: GUARDIAN,
        senderDisplayName: "Guardian",
        text: "hello from the full body",
        attachments: [],
        timestamp: new Date(0),
        thread: { kind: "dm", name: "Hi" },
        raw: buildEvent(),
      },
    ]);
  });

  it("rejects a deposit with a bad HMAC and never dispatches", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    const raw = JSON.stringify(buildEvent());
    const result = await adapter.ingestInbound(raw, "deadbeef");

    expect(result.status).toBe("rejected");
    expect(received).toHaveLength(0);
    expect(provider.getMessage).not.toHaveBeenCalled();
  });

  it("routes a spoofed guardian (From matches but unauthenticated) as untrusted", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    const event = buildEvent({
      authentication: { authenticated: false, spam: false, blocked: false },
      labels: ["received", "unread", "unauthenticated"],
    });
    const raw = JSON.stringify(event);
    const result = await adapter.ingestInbound(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(received).toHaveLength(1);
    // Namespaced so it can never match the preset guardian channel mapping.
    expect(received[0].senderId).toBe(`unauthenticated:${GUARDIAN}`);
  });

  it("dispatches an unknown authenticated sender under their own address", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    const event = buildEvent({ from: [{ email: "stranger@elsewhere.com" }] });
    const raw = JSON.stringify(event);
    const result = await adapter.ingestInbound(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(received[0].senderId).toBe("stranger@elsewhere.com");
  });

  it("namespaces a non-guardian sender that fails authentication so it can't match a person mapping", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    // A spoofed From for a mapped non-guardian contact (e.g. inner-circle).
    // Without the namespace the raw address would resolve to that person and
    // reach the trusted path, bypassing sentinel.
    const event = buildEvent({
      from: [{ email: "contact@elsewhere.com" }],
      authentication: { authenticated: false, spam: false, blocked: false },
      labels: ["received", "unread", "unauthenticated"],
    });
    const raw = JSON.stringify(event);
    const result = await adapter.ingestInbound(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(received[0].senderId).toBe("unauthenticated:contact@elsewhere.com");
  });

  it("dedupes an at-least-once redelivery of the same providerMessageId", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    // Same deposit delivered twice (relay redelivers an un-acked seq after a
    // reconnect). The second must be skipped, not re-dispatched to the agent.
    const raw = JSON.stringify(buildEvent());
    const first = await adapter.ingestInbound(raw, sign(raw));
    const second = await adapter.ingestInbound(raw, sign(raw));

    expect(first.status).toBe("dispatched");
    expect(second).toEqual({ status: "skipped", reason: "duplicate" });
    expect(received).toHaveLength(1);
    // The duplicate is dropped before the body pull, so no second provider hit.
    expect(provider.getMessage).toHaveBeenCalledTimes(1);
  });
});

describe("EmailAdapter.send", () => {
  it("replies on-thread after an inbound (uses inReplyToMessageId)", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    adapter.onInbound(async () => {});

    const raw = JSON.stringify(buildEvent());
    await adapter.ingestInbound(raw, sign(raw));

    const receipt = await adapter.send("t1" as ChatId, { text: "my reply" });

    expect(provider.sent).toHaveLength(1);
    // Multipart: markdown text + rendered HTML.
    expect(provider.sent[0].inReplyToMessageId).toBe("msg_1");
    expect(provider.sent[0].text).toBe("my reply");
    expect(provider.sent[0].html).toContain("my reply");
    expect(provider.sent[0].to).toBeUndefined();
    // The provider's thread id names the conversation the email went out in.
    expect(receipt).toEqual({ chatId: "t_out", messageId: "m_out" });
  });

  it("starts a fresh email when a chat-style conversation names an address", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    await adapter.send("zoolsher@gmail.com" as ChatId, { text: "cold open" });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toBe("zoolsher@gmail.com");
    expect(provider.sent[0].text).toBe("cold open");
    expect(provider.sent[0].html).toContain("cold open");
    expect(provider.sent[0].inReplyToMessageId).toBeUndefined();
  });

  it("addresses a new email via the email union: to + subject + cc, resolving guardian", async () => {
    const provider = makeProvider();
    // The `guardian` recipient alias resolves via the guardian address the
    // adapter reads from settings config at start().
    const adapter = new EmailAdapter({
      provider,
      settingsRepo: {
        get: async () => ({ enabled: true, guardianEmail: GUARDIAN }),
        set: async () => {},
      } as unknown as SettingsRepository,
      peopleRepo: {
        byAccount: async () => null,
        isDismissed: async () => false,
        byBondLevel: async () => [],
      } as unknown as PeopleRepository,
      config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
    });
    await adapter.start();

    await adapter.send("" as ChatId, {
      kind: "email",
      text: "**hi**",
      to: ["guardian", "Other <other@x.com>"],
      subject: "Hello",
      cc: ["c@x.com"],
    });

    expect(provider.sent).toHaveLength(1);
    const sent = provider.sent[0];
    expect(sent.to).toEqual([GUARDIAN, "other@x.com"]);
    expect(sent.subject).toBe("Hello");
    expect(sent.cc).toEqual(["c@x.com"]);
    expect(sent.text).toBe("**hi**");
    expect(sent.html).toContain(">hi</strong>");
    expect(sent.inReplyToMessageId).toBeUndefined();
  });

  it("replies on-thread when an explicit inReplyToMessageId is given (no thread map needed)", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    await adapter.send("t-restarted" as ChatId, {
      kind: "email",
      text: "after restart",
      inReplyToMessageId: "msg_persisted",
    });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].inReplyToMessageId).toBe("msg_persisted");
    expect(provider.sent[0].to).toBeUndefined();
  });

  it("sanitizes app-provided HTML and derives a text/plain alternative", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    await adapter.send("" as ChatId, {
      kind: "email",
      to: "report@x.com",
      subject: "Report",
      html: "<p>Safe</p><script>alert(1)</script>",
    });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].html).toContain("Safe");
    expect(provider.sent[0].html).not.toContain("<script");
    expect(provider.sent[0].text).toContain("Safe");
  });

  it("receipts the conversation it was asked for when nothing is sent", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    const receipt = await adapter.send("t-empty" as ChatId, { text: "   " });

    expect(provider.sent).toHaveLength(0);
    expect(provider.listMessages).not.toHaveBeenCalled();
    expect(receipt).toEqual({ chatId: "t-empty" });
  });

  it("skips a parts-only approval card without a provider call or an error", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    const receipt = await adapter.send("t-approval" as ChatId, {
      parts: [
        {
          type: "approval_card",
          approvalId: "approval-1",
          actionName: "send_message",
          preview: { kind: "generic", title: "Send email", summary: "The agent wants to send." },
          status: "pending",
        },
      ],
    });

    expect(receipt).toEqual({ chatId: "t-approval" });
    expect(provider.send).not.toHaveBeenCalled();
    expect(provider.listMessages).not.toHaveBeenCalled();
  });

  it("names the rejected recipient and the fix when no address resolves", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    await expect(
      adapter.send("" as ChatId, { kind: "email", to: "not-an-address", text: "hi" }),
    ).rejects.toThrow('"not-an-address" is not an email address. No email was sent.');
    await expect(
      adapter.send("" as ChatId, { kind: "email", to: "guardian", text: "hi" }),
    ).rejects.toThrow("Rome has no guardian email address yet");
    await expect(adapter.send("guardian" as ChatId, { text: "hi" })).rejects.toThrow(
      "Rome has no guardian email address yet",
    );
    expect(provider.listMessages).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("rejects an explicit email request whose body is empty", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    await expect(
      adapter.send("" as ChatId, { kind: "email", to: "a@example.com", text: "   " }),
    ).rejects.toThrow("Email requires non-empty text or HTML. No email was sent.");
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("points dashboard links at the instance's public origin", async () => {
    rs.stubEnv("PANTHEON_INSTANCE_ORIGIN", "https://acme.romeos.cc");
    try {
      const provider = makeProvider();
      const adapter = makeAdapter(provider);

      await adapter.send("zoolsher@gmail.com" as ChatId, {
        text: "Open [file.md](</memory/topics/file.md>)",
      });

      expect(provider.sent[0].text).toBe(
        "Open [file.md](<https://acme.romeos.cc/memory/topics/file.md>)",
      );
      expect(provider.sent[0].html).toContain(
        'href="https://acme.romeos.cc/memory/topics/file.md"',
      );
      expect(provider.sent[0].html).toContain('href="https://acme.romeos.cc/settings"');
    } finally {
      rs.unstubAllEnvs();
    }
  });
});

describe("EmailAdapter inbound attachments", () => {
  let sandboxHome: string;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "rome-email-"));
    rs.stubEnv("HOME", sandboxHome);
    rs.stubEnv("ROME_PROFILE", "email-test");
  });

  afterEach(async () => {
    rs.unstubAllEnvs();
    rs.unstubAllGlobals();
    await rm(sandboxHome, { recursive: true, force: true });
  });

  it("surfaces an attachment manifest and pulls bytes via presigned URL", async () => {
    const bytes = Buffer.from("hello-bytes");
    const fetchMock = rs.fn(async () => new Response(bytes, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    const provider = makeProvider({
      getAttachment: rs.fn(async () => ({
        downloadUrl: "https://files.example/presigned",
        expiresAt: new Date(0).toISOString(),
        filename: "doc.pdf",
        contentType: "application/pdf",
        size: bytes.length,
      })),
    });
    const adapter = makeAdapter(provider);
    const received: ChannelMessage[] = [];
    adapter.onInbound(async (m) => {
      received.push(m);
    });

    const event = buildEvent({
      hasAttachment: true,
      attachments: [
        { blobId: "att_1", name: "doc.pdf", size: bytes.length, type: "application/pdf" },
      ],
    });
    const raw = JSON.stringify(event);
    await adapter.ingestInbound(raw, sign(raw));

    expect(received).toHaveLength(1);
    expect(received[0].attachments).toHaveLength(1);
    expect(received[0].attachments[0].type).toBe("document");

    const saved = await adapter.saveIncomingAttachments(received[0]);
    expect(provider.getAttachment).toHaveBeenCalledWith("msg_1", "att_1");
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/presigned", expect.anything());
    expect(saved[0].localPath).toBeTruthy();
    // Saved under the same channel/conversation/message path as before.
    expect(saved[0].localPath).toContain(join("channel-attachments", "email", "t1", "msg_1"));

    rs.unstubAllGlobals();
  });

  it("returns the attachments unchanged for a message it did not ingest", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const attachments = [{ type: "document" as const, fileName: "doc.pdf" }];

    const saved = await adapter.saveIncomingAttachments({
      channel: "email",
      direction: "inbound",
      messageId: "msg_unknown",
      chatId: "t1" as ChatId,
      senderId: GUARDIAN,
      text: "",
      attachments,
      timestamp: new Date(0),
    });

    expect(saved).toBe(attachments);
    expect(provider.getAttachment).not.toHaveBeenCalled();
  });
});

describe("EmailAdapter.start guardian resolution", () => {
  it("seeds the guardian from the Rome Cloud account email when none is configured", async () => {
    const provider = makeProvider();
    const stored: Record<string, unknown> = {};
    const settingsRepo = {
      get: rs.fn(async () => stored.email),
      set: rs.fn(async (key: string, value: unknown) => {
        stored[key] = value;
      }),
    } as unknown as SettingsRepository;
    const peopleRepo = {
      byAccount: rs.fn(async () => null),
      isDismissed: async () => false,
      byBondLevel: rs.fn(async () => []),
      linkStated: rs.fn(async () => {}),
    } as unknown as PeopleRepository;

    const adapter = new EmailAdapter({
      provider,
      settingsRepo,
      peopleRepo,
      // No guardianEmail in settings → self-heal resolves it from Rome Cloud.
      config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
      ownerEmailResolver: async () => "Owner@Example.com",
    });

    await adapter.start();

    // start() never provisions (route-driven grant).
    expect(provider.provision).not.toHaveBeenCalled();
    // Normalized (lowercased) and persisted back into the email setting.
    expect(settingsRepo.set).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({ guardianEmail: "owner@example.com" }),
    );
    // The resolved address is used to seed the guardian channel mapping.
    expect(peopleRepo.byAccount).toHaveBeenCalledWith({
      platform: "email",
      id: "owner@example.com",
    });
  });

  it("keeps a settings-configured guardian email and never calls the cloud resolver", async () => {
    const provider = makeProvider();
    // guardianEmail is durable settings config: the row carries it, and start()
    // reads it from there rather than the grant material.
    const settingsRepo = {
      get: rs.fn(async () => ({ enabled: true, guardianEmail: "set@example.com" })),
      set: rs.fn(async () => {}),
    } as unknown as SettingsRepository;
    const peopleRepo = {
      byAccount: rs.fn(async () => null),
      isDismissed: async () => false,
      byBondLevel: rs.fn(async () => []),
      linkStated: rs.fn(async () => {}),
    } as unknown as PeopleRepository;
    const resolver = rs.fn(async () => "owner@example.com");

    const adapter = new EmailAdapter({
      provider,
      settingsRepo,
      peopleRepo,
      config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
      ownerEmailResolver: resolver,
    });

    await adapter.start();

    expect(resolver).not.toHaveBeenCalled();
    expect(peopleRepo.byAccount).toHaveBeenCalledWith({
      platform: "email",
      id: "set@example.com",
    });
  });

  it("resolves guardianEmail from Rome Cloud on a later boot when it was unresolvable at connect", async () => {
    const provider = makeProvider();
    // A single settings store shared across two boots (the row persists).
    const stored: Record<string, unknown> = { email: { enabled: true } };
    const settingsRepo = {
      get: rs.fn(async (key: string) => stored[key]),
      set: rs.fn(async (key: string, value: unknown) => {
        stored[key] = value;
      }),
    } as unknown as SettingsRepository;
    const peopleRepo = {
      byAccount: rs.fn(async () => null),
      isDismissed: async () => false,
      byBondLevel: rs.fn(async () => []),
      linkStated: rs.fn(async () => {}),
    } as unknown as PeopleRepository;

    // Rome Cloud can't answer yet at connect-time boot.
    let ownerEmail: string | undefined;
    const bootAdapter = () =>
      new EmailAdapter({
        provider,
        settingsRepo,
        peopleRepo,
        config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
        ownerEmailResolver: async () => ownerEmail,
      });

    // Boot 1 (connect): unresolvable → gate stays closed, nothing persisted.
    await bootAdapter().start();
    expect((stored.email as { guardianEmail?: string }).guardianEmail).toBeUndefined();

    // Boot 2 (a later restart): Rome Cloud now returns the account email, so the
    // self-heal resolves + persists it (normalized).
    ownerEmail = "Owner@Example.com";
    await bootAdapter().start();
    expect((stored.email as { guardianEmail?: string }).guardianEmail).toBe("owner@example.com");
    expect(peopleRepo.byAccount).toHaveBeenLastCalledWith({
      platform: "email",
      id: "owner@example.com",
    });
  });
});

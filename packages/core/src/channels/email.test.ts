import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { NormalizedMessage } from "@rome-os/app-runtime";
import { EmailAdapter, type EmailInboxCoordinates } from "./email.js";
import type {
  MailProvider,
  RomeMailEvent,
  RomeMailListItem,
  RomeMailMessage,
  SendMailInput,
  SendMailResult,
} from "../lib/rome-cloud-mail.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";

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
    personMappingRepo: {} as unknown as PersonMappingRepository,
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
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });

    const raw = JSON.stringify(buildEvent());
    const result = await adapter.ingestInbound(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe("email");
    expect(received[0].channelUserId).toBe(GUARDIAN);
    expect(received[0].text).toBe("hello from the full body");
    expect(received[0].threadId).toBe("t1");
  });

  it("rejects a deposit with a bad HMAC and never dispatches", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
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
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
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
    expect(received[0].channelUserId).toBe(`unauthenticated:${GUARDIAN}`);
  });

  it("dispatches an unknown authenticated sender under their own address", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });

    const event = buildEvent({ from: [{ email: "stranger@elsewhere.com" }] });
    const raw = JSON.stringify(event);
    const result = await adapter.ingestInbound(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(received[0].channelUserId).toBe("stranger@elsewhere.com");
  });

  it("namespaces a non-guardian sender that fails authentication so it can't match a person mapping", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
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
    expect(received[0].channelUserId).toBe("unauthenticated:contact@elsewhere.com");
  });

  it("dedupes an at-least-once redelivery of the same providerMessageId", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
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

describe("EmailAdapter.sendMessage", () => {
  it("replies on-thread after an inbound (uses inReplyToMessageId)", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);
    adapter.onMessage(async () => {});

    const raw = JSON.stringify(buildEvent());
    await adapter.ingestInbound(raw, sign(raw));

    await adapter.sendMessage(GUARDIAN, "t1", { text: "my reply" });

    expect(provider.sent).toHaveLength(1);
    // Multipart: markdown text + rendered HTML.
    expect(provider.sent[0].inReplyToMessageId).toBe("msg_1");
    expect(provider.sent[0].text).toBe("my reply");
    expect(provider.sent[0].html).toContain("my reply");
    expect(provider.sent[0].to).toBeUndefined();
  });

  it("starts a fresh email when the thread is unknown", async () => {
    const provider = makeProvider();
    const adapter = makeAdapter(provider);

    await adapter.sendMessage("zoolsher@gmail.com", "new-thread", { text: "cold open" });

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
      personMappingRepo: {
        findByChannelUser: async () => null,
        findByBondLevel: async () => [],
      } as unknown as PersonMappingRepository,
      config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
    });
    await adapter.start();

    await adapter.sendMessage("ignored", "", {
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

    await adapter.sendMessage("someone@x.com", "t-restarted", {
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

    await adapter.sendMessage("x", "", {
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
    const received: NormalizedMessage[] = [];
    adapter.onMessage(async (m) => {
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

    rs.unstubAllGlobals();
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
    const personMappingRepo = {
      findByChannelUser: rs.fn(async () => null),
      findByBondLevel: rs.fn(async () => []),
      addChannelMapping: rs.fn(async () => {}),
    } as unknown as PersonMappingRepository;

    const adapter = new EmailAdapter({
      provider,
      settingsRepo,
      personMappingRepo,
      // No guardianEmail in settings → self-heal resolves it from Rome Cloud.
      config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
      ownerEmailResolver: async () => "Owner@Example.com",
    });

    await adapter.start();

    // start() never provisions (route-driven conferral).
    expect(provider.provision).not.toHaveBeenCalled();
    // Normalized (lowercased) and persisted back into the email setting.
    expect(settingsRepo.set).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({ guardianEmail: "owner@example.com" }),
    );
    // The resolved address is used to seed the guardian channel mapping.
    expect(personMappingRepo.findByChannelUser).toHaveBeenCalledWith("email", "owner@example.com");
  });

  it("keeps a settings-configured guardian email and never calls the cloud resolver", async () => {
    const provider = makeProvider();
    // guardianEmail is durable settings config: the row carries it, and start()
    // reads it from there rather than the grant material.
    const settingsRepo = {
      get: rs.fn(async () => ({ enabled: true, guardianEmail: "set@example.com" })),
      set: rs.fn(async () => {}),
    } as unknown as SettingsRepository;
    const personMappingRepo = {
      findByChannelUser: rs.fn(async () => null),
      findByBondLevel: rs.fn(async () => []),
      addChannelMapping: rs.fn(async () => {}),
    } as unknown as PersonMappingRepository;
    const resolver = rs.fn(async () => "owner@example.com");

    const adapter = new EmailAdapter({
      provider,
      settingsRepo,
      personMappingRepo,
      config: { address: "slug@mail.romeos.cc", inboundSecret: INBOUND_SECRET },
      ownerEmailResolver: resolver,
    });

    await adapter.start();

    expect(resolver).not.toHaveBeenCalled();
    expect(personMappingRepo.findByChannelUser).toHaveBeenCalledWith("email", "set@example.com");
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
    const personMappingRepo = {
      findByChannelUser: rs.fn(async () => null),
      findByBondLevel: rs.fn(async () => []),
      addChannelMapping: rs.fn(async () => {}),
    } as unknown as PersonMappingRepository;

    // Rome Cloud can't answer yet at connect-time boot.
    let ownerEmail: string | undefined;
    const bootAdapter = () =>
      new EmailAdapter({
        provider,
        settingsRepo,
        personMappingRepo,
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
    expect(personMappingRepo.findByChannelUser).toHaveBeenLastCalledWith(
      "email",
      "owner@example.com",
    );
  });
});

describe("EmailAdapter.fetchHistory", () => {
  function listItem(overrides: Partial<RomeMailListItem> = {}): RomeMailListItem {
    return {
      providerMessageId: "m1",
      threadId: "tA",
      from: "Alice <alice@example.com>",
      subject: "Earlier",
      preview: "preview-1",
      receivedAt: new Date(1000).toISOString(),
      labels: ["received"],
      ...overrides,
    };
  }

  function fullMessage(
    id: string,
    body: string,
    overrides: Partial<RomeMailMessage> = {},
  ): RomeMailMessage {
    return {
      id,
      threadId: "tA",
      receivedAt: new Date(0).toISOString(),
      body: { markdown: body },
      attachments: [],
      hasAttachment: false,
      provider: "agentmail",
      providerMessageId: id,
      mailboxAddress: "slug@mail.romeos.cc",
      direction: "inbound",
      authentication: { authenticated: true, spam: false, blocked: false },
      labels: [],
      ...overrides,
    };
  }

  it("lists by time window, hydrates each body, and returns oldest-first", async () => {
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({
        messages: [
          listItem({
            providerMessageId: "m2",
            threadId: "tB",
            from: "Bob <bob@example.com>",
            receivedAt: new Date(2000).toISOString(),
          }),
          listItem({ providerMessageId: "m1", receivedAt: new Date(1000).toISOString() }),
        ],
        nextPageToken: undefined,
      })),
      getMessage: rs.fn(async (id: string) =>
        fullMessage(id, `body-${id}`, {
          from: [{ name: id === "m1" ? "Alice" : "Bob", email: `${id}@example.com` }],
        }),
      ),
    });
    const adapter = makeAdapter(provider);

    const messages = await adapter.fetchHistory(null, 24);

    // `after` is the window cutoff, newest-first paging.
    const listArgs = (provider.listMessages as ReturnType<typeof rs.fn>).mock.calls[0][0];
    expect(listArgs.ascending).toBe(false);
    expect(new Date(listArgs.after).getTime()).toBeLessThanOrEqual(
      Date.now() - 24 * 60 * 60 * 1000 + 1000,
    );
    // Body hydrated per message; oldest (m1) first.
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0].text).toBe("body-m1");
    expect(messages[0].displayName).toBe("Alice");
    expect(provider.getMessage).toHaveBeenCalledTimes(2);
  });

  it("filters to a single thread when threadId is given", async () => {
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({
        messages: [
          listItem({ providerMessageId: "m1", threadId: "tA" }),
          listItem({
            providerMessageId: "m2",
            threadId: "tB",
            receivedAt: new Date(2000).toISOString(),
          }),
        ],
      })),
      getMessage: rs.fn(async (id: string) => fullMessage(id, `body-${id}`)),
    });
    const adapter = makeAdapter(provider);

    const messages = await adapter.fetchHistory("tA", 24);

    expect(messages.map((m) => m.id)).toEqual(["m1"]);
    expect(provider.getMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps paging for a thread match past the cap of non-matching messages", async () => {
    // The target thread sits *after* more than HISTORY_MAX_MESSAGES (200) newer
    // messages in other threads. Because the cap counts matches (not raw volume),
    // the fetch must page past the noise and still find it — the regression this
    // guards is the cap being applied to the global stream before the filter.
    const NOISE = 250;
    const pages: { messages: RomeMailListItem[]; nextPageToken?: string }[] = [];
    for (let i = 0; i < NOISE; i += 100) {
      pages.push({
        messages: Array.from({ length: Math.min(100, NOISE - i) }, (_, j) =>
          listItem({ providerMessageId: `noise-${i + j}`, threadId: "tNoise" }),
        ),
        nextPageToken: `p${pages.length + 1}`,
      });
    }
    pages.push({
      messages: [listItem({ providerMessageId: "wanted", threadId: "tWanted" })],
      nextPageToken: undefined,
    });

    let call = 0;
    const provider = makeProvider({
      listMessages: rs.fn(async () => pages[call++]),
      getMessage: rs.fn(async (id: string) =>
        fullMessage(id, `body-${id}`, { threadId: "tWanted" }),
      ),
    });
    const adapter = makeAdapter(provider);

    const messages = await adapter.fetchHistory("tWanted", 24);

    expect(messages.map((m) => m.id)).toEqual(["wanted"]);
    // Only the one match is hydrated; the 250 noise messages never are.
    expect(provider.getMessage).toHaveBeenCalledTimes(1);
  });

  it("terminates on an empty page that carries a non-null cursor (no infinite loop)", async () => {
    // A misbehaving provider: every page is empty but advertises more. The scan
    // cap counts messages (0 here), so the empty-page guard is what must stop us.
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({ messages: [], nextPageToken: "always-more" })),
      getMessage: rs.fn(async (id: string) => fullMessage(id, `body-${id}`)),
    });
    const adapter = makeAdapter(provider);

    const messages = await adapter.fetchHistory("tWanted", 24);

    expect(messages).toEqual([]);
    // Stopped on the first empty page rather than following the cursor forever.
    expect(provider.listMessages).toHaveBeenCalledTimes(1);
  });

  it("falls back to the list preview when body hydration fails", async () => {
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({
        messages: [listItem({ providerMessageId: "m1", preview: "the preview body" })],
      })),
      getMessage: rs.fn(async () => {
        throw new Error("pull failed");
      }),
    });
    const adapter = makeAdapter(provider);

    const messages = await adapter.fetchHistory(null, 24);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("the preview body");
  });

  it("is side-effect free: a later reply does not ride a thread it never ingested", async () => {
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({
        messages: [listItem({ providerMessageId: "m1", threadId: "tA" })],
      })),
      getMessage: rs.fn(async (id: string) => fullMessage(id, `body-${id}`)),
    });
    const adapter = makeAdapter(provider);

    await adapter.fetchHistory(null, 24);
    // fetchHistory must not have recorded a reply target for tA — so a send to
    // that thread starts a fresh email (with `to`) rather than an in-thread reply.
    await adapter.sendMessage("alice@example.com", "tA", { text: "hello" });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].inReplyToMessageId).toBeUndefined();
    expect(provider.sent[0].to).toBe("alice@example.com");
  });

  it("attributes outbound (sent) messages to Rome, keeping a two-sided transcript", async () => {
    // A thread with one received message and one Rome-sent reply. The sent one is
    // labeled "sent" and its `from` is our own inbox. It must be attributed to
    // Rome, not to the counterparty — otherwise the transcript misreads our own
    // replies as theirs.
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({
        messages: [
          listItem({
            providerMessageId: "out",
            threadId: "tA",
            from: "slug@mail.romeos.cc",
            labels: ["sent"],
            receivedAt: new Date(2000).toISOString(),
          }),
          listItem({
            providerMessageId: "in",
            threadId: "tA",
            from: "Alice <alice@example.com>",
            labels: ["received"],
            receivedAt: new Date(1000).toISOString(),
          }),
        ],
      })),
      getMessage: rs.fn(async (id: string) =>
        fullMessage(id, `body-${id}`, {
          from:
            id === "out"
              ? [{ email: "slug@mail.romeos.cc" }]
              : [{ name: "Alice", email: "alice@example.com" }],
        }),
      ),
    });
    const adapter = makeAdapter(provider);

    const messages = await adapter.fetchHistory("tA", 24);

    expect(messages.map((m) => m.id)).toEqual(["in", "out"]);
    // Inbound → counterparty; outbound → Rome's own address.
    expect(messages[0].channelUserId).toBe("alice@example.com");
    expect(messages[0].displayName).toBe("Alice");
    expect(messages[1].channelUserId).toBe("slug@mail.romeos.cc");
    expect(messages[1].displayName).toBe("slug@mail.romeos.cc");
  });

  it("clamps an invalid windowHours to the default look-back", async () => {
    const provider = makeProvider({
      listMessages: rs.fn(async () => ({ messages: [], nextPageToken: undefined })),
    });
    const adapter = makeAdapter(provider);

    for (const bad of [NaN, Infinity, -5, 0]) {
      (provider.listMessages as ReturnType<typeof rs.fn>).mockClear();
      await adapter.fetchHistory(null, bad);
      const listArgs = (provider.listMessages as ReturnType<typeof rs.fn>).mock.calls[0][0];
      // Falls back to a finite 24h cutoff rather than throwing or inverting it.
      const afterMs = new Date(listArgs.after).getTime();
      expect(Number.isFinite(afterMs)).toBe(true);
      expect(afterMs).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000 + 2000);
      expect(afterMs).toBeGreaterThan(Date.now() - 25 * 60 * 60 * 1000);
    }
  });
});

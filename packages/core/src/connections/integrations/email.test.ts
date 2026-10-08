// The Email descriptor. Email is push-driven (no live transport
// loop), so its fault mapping is exercised through the two out-of-band signals
// documented in email.ts:
//   1. descriptor shape — one `inbox` grant, a talker needing it.
//   2. registry-level: import unlocks talk; send()/ingestInbound() round-trip
//      through the wrapped EmailAdapter.
//   3. fault mapping: ingestInbound's bad_signature verdict → CredentialRejected
//      { grant: "inbox" }; adapter.start() rejecting (Rome Cloud outage) →
//      Disconnected.
//   4. end-to-end over the real ConnectionRegistry: a bad-signature deposit
//      degrades the inbox grant (renew-once via setup-driven "re-confer").

import type { ChannelMessage } from "@rome-os/app-runtime";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type {
  MailProvider,
  RomeMailEvent,
  RomeMailMessage,
  SendMailInput,
  SendMailResult,
} from "../../lib/rome-cloud-mail.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../../db/repositories/settings.js";
import type { EmailInboundResult } from "../../channels/email-control.js";
import { createTestDb } from "../../test/helpers.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { ConversationId, StreamFault, Talker } from "../types.js";
import { makeEmailDescriptor, type EmailDescriptorDeps, type EmailInboxMaterial } from "./email.js";

const INBOUND_SECRET = "test-inbound-secret";
const GUARDIAN = "guardian@example.com";
const ADDRESS = "slug@mail.romeos.cc";

// A fresh drizzle-backed ledger per test; opened DBs are closed after each test.
const openDbs: Array<() => void> = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.();
});
function makeLedger(): DrizzleGrantLedger {
  const { db, close } = createTestDb();
  openDbs.push(close);
  return new DrizzleGrantLedger(db);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProvider(overrides: Partial<MailProvider> = {}): MailProvider & {
  sent: SendMailInput[];
} {
  const sent: SendMailInput[] = [];
  return {
    sent,
    provision: rs.fn(async () => ({ address: ADDRESS, inboundSecret: INBOUND_SECRET })),
    send: async (input: SendMailInput): Promise<SendMailResult> => {
      sent.push(input);
      return { messageId: "m_out", threadId: "t_out" };
    },
    getMessage: async (messageId: string): Promise<RomeMailMessage> => ({
      id: messageId,
      threadId: "t1",
      receivedAt: new Date(0).toISOString(),
      body: { markdown: "hello from the full body" },
      attachments: [],
      hasAttachment: false,
      provider: "agentmail",
      providerMessageId: messageId,
      mailboxAddress: ADDRESS,
      direction: "inbound",
      authentication: { authenticated: true, spam: false, blocked: false },
      labels: [],
    }),
    getAttachment: async () => ({
      downloadUrl: "https://example.com/x",
      expiresAt: new Date(0).toISOString(),
      size: 0,
    }),
    listMessages: async () => ({ messages: [], nextPageToken: undefined }),
    ...overrides,
  };
}

function buildEvent(overrides: Partial<RomeMailEvent> = {}): RomeMailEvent {
  return {
    type: "message.received",
    provider: "agentmail",
    mailboxAddress: ADDRESS,
    id: "evt_1",
    providerMessageId: "msg_1",
    threadId: "t1",
    from: [{ name: "Guardian", email: GUARDIAN }],
    to: [{ email: ADDRESS }],
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

function sign(rawBody: string, secret = INBOUND_SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** An in-memory settings fake satisfying the adapter's get/set surface. The
 *  adapter reads `guardianEmail` (durable config) from here at start(); the grant
 *  material carries only the provisioned coordinates. */
function makeSettingsRepo(
  initial: Record<string, unknown> = {},
): SettingsRepository & { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: (async (key: string) => store[key]) as SettingsRepository["get"],
    set: (async (key: string, value: unknown) => {
      store[key] = value;
    }) as SettingsRepository["set"],
  } as SettingsRepository & { store: Record<string, unknown> };
}

/** A person-mapping fake: no guardian person exists, so mapGuardianToChannel is a
 *  no-op — keeps start() off any write path in the descriptor tests. */
function makePersonMappingRepo(): PersonMappingRepository {
  return {
    findByChannelUser: async () => null,
    findByBondLevel: async () => [],
  } as unknown as PersonMappingRepository;
}

function makeDeps(
  provider: MailProvider,
  overrides: Partial<EmailDescriptorDeps> = {},
): EmailDescriptorDeps {
  return {
    provider,
    settingsRepo: makeSettingsRepo(),
    personMappingRepo: makePersonMappingRepo(),
    // Never hit the real whoami during tests; guardian stays unresolved
    // unless a test's settings row carries it.
    ownerEmailResolver: async () => undefined,
    ...overrides,
  };
}

const validCred = (material: Partial<EmailInboxMaterial> = {}) => ({
  material: {
    address: ADDRESS,
    inboundSecret: INBOUND_SECRET,
    ...material,
  },
  expiresAt: "never" as const,
});

describe("email descriptor shape", () => {
  it("declares one `inbox` grant and a talker needing it", () => {
    const desc = makeEmailDescriptor(makeDeps(makeProvider()));
    expect(desc.service).toBe("email");
    expect(Object.keys(desc.auth)).toEqual(["inbox"]);
    expect(desc.capabilities.talker?.needs).toEqual(["inbox"]);
    expect(desc.capabilities.actor).toBeUndefined();
    expect(desc.capabilities.watcher).toBeUndefined();
  });

  it("confer() is setup-driven — throws, never prompts headlessly", async () => {
    const desc = makeEmailDescriptor(makeDeps(makeProvider()));
    await expect(
      desc.auth.inbox.confer({
        prompt: () => Promise.reject(new Error("should not be called")),
      }),
    ).rejects.toThrow("conferral driven by the connect setup");
  });

  it("renew() always answers re-confer", async () => {
    const desc = makeEmailDescriptor(makeDeps(makeProvider()));
    await expect(desc.auth.inbox.renew(validCred())).resolves.toBe("re-confer");
  });
});

// A direct-Talker harness bypassing the registry, mirroring telegram's
// buildTalker helper — observes exactly what the builder reports to fault().
function buildTalker(
  provider: MailProvider,
  material: Partial<EmailInboxMaterial> = {},
  depsOverride: Partial<EmailDescriptorDeps> = {},
): {
  talker: Talker;
  faults: StreamFault[];
  start: () => void;
  ingest: (rawBody: string, signature: string) => Promise<EmailInboundResult>;
} {
  const desc = makeEmailDescriptor(makeDeps(provider, depsOverride));
  let ingress: ((input: unknown) => Promise<unknown>) | undefined;
  const talker = desc.capabilities.talker!.build(
    { inbox: validCred(material) },
    {
      connectionId: "email-test",
      persist: async () => {},
      registerIngress: (handler) => {
        ingress = handler;
        return () => {
          ingress = undefined;
        };
      },
    },
  );
  const faults: StreamFault[] = [];
  return {
    talker,
    faults,
    start: () =>
      talker.start(
        () => {},
        (err) => faults.push(err),
      ),
    ingest: async (rawBody, signature) =>
      (ingress?.({ rawBody, signature }) ??
        Promise.reject(new Error("ingress unavailable"))) as Promise<EmailInboundResult>,
  };
}

describe("email Talker fault mapping", () => {
  it("maps ingestInbound's bad_signature verdict to CredentialRejected{ grant: 'inbox' }", async () => {
    const provider = makeProvider();
    const h = buildTalker(provider);
    h.start();

    const raw = JSON.stringify(buildEvent());
    const result = await h.ingest(raw, "not-the-right-signature");

    expect(result).toEqual({ status: "rejected", reason: "bad_signature" });
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(CredentialRejected);
    expect((h.faults[0] as CredentialRejected).grant).toBe("inbox");
  });

  it("does not fault on a well-signed, well-formed deposit", async () => {
    const provider = makeProvider();
    const h = buildTalker(provider);
    h.start();

    const raw = JSON.stringify(buildEvent());
    const result = await h.ingest(raw, sign(raw));

    expect(result.status).toBe("dispatched");
    expect(h.faults).toHaveLength(0);
  });

  it("never provisions from start() — the route is the sole provisioner", async () => {
    const provider = makeProvider();
    const h = buildTalker(provider);
    h.start();
    await flush();

    // start() builds the transport from the grant material it was handed; it must
    // never reach for MailProvider.provision() (conferral is
    // setup-driven), and a valid grant produces no fault.
    expect(provider.provision).not.toHaveBeenCalled();
    expect(h.faults).toHaveLength(0);
  });

  it("maps a start() failure to Disconnected (backoff), never a credential fault", async () => {
    // A transport/infra failure at start time (here: the settings store is
    // unreachable while start() reads the durable guardian config) must surface
    // as Disconnected so the registry backs off and rebuilds — it must NOT
    // degrade the (perfectly valid) inbox credential.
    const provider = makeProvider();
    const brokenSettings = {
      get: async () => {
        throw new Error("settings store unreachable");
      },
      set: async () => {},
    } as unknown as SettingsRepository;
    const h = buildTalker(provider, {}, { settingsRepo: brokenSettings });
    h.start();
    await flush();

    expect(provider.provision).not.toHaveBeenCalled();
    expect(h.faults).toHaveLength(1);
    expect(h.faults[0]).toBeInstanceOf(Disconnected);
    expect(h.faults[0]).not.toBeInstanceOf(CredentialRejected);
  });

  it("delivers inbound messages through ingestInbound into deliver()", async () => {
    const provider = makeProvider();
    const desc = makeEmailDescriptor(makeDeps(provider));
    let ingress: ((input: unknown) => Promise<unknown>) | undefined;
    const talker = desc.capabilities.talker!.build(
      { inbox: validCred() },
      {
        connectionId: "email-test",
        persist: async () => {},
        registerIngress: (handler) => {
          ingress = handler;
          return () => {};
        },
      },
    );
    const received: ChannelMessage[] = [];
    talker.start(
      (msg) => received.push(msg),
      () => {},
    );

    const raw = JSON.stringify(buildEvent());
    await ingress?.({ rawBody: raw, signature: sign(raw) });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello from the full body");
  });

  it("forwards send() to the provider", async () => {
    const provider = makeProvider();
    const h = buildTalker(provider);
    h.start();

    const receipt = await h.talker.send("t1" as ConversationId, {
      kind: "email",
      to: "someone@example.com",
      text: "hi there",
    });

    expect(provider.sent).toHaveLength(1);
    expect(receipt).toStrictEqual({ conversationId: "t_out", messageId: "m_out" });
  });

  it("marks the lines this inbox sent as outbound, however its address is written", async () => {
    const provider = makeProvider({
      listMessages: async () => ({
        messages: [
          {
            providerMessageId: "mine",
            threadId: "t1",
            from: ADDRESS,
            subject: "",
            preview: "",
            receivedAt: new Date().toISOString(),
            labels: ["sent"],
          },
        ],
      }),
    });
    const h = buildTalker(provider, { address: `Rome <${ADDRESS.toUpperCase()}>` });
    h.start();

    const history = await h.talker.history?.query({});
    expect(history?.map((line) => [line.messageId, line.direction])).toEqual([
      ["mine", "outbound"],
    ]);
  });

  // The flag is what gives the channel a \`messages\` port; the feature is what
  // answers it. A Talk offering one without the other is unreachable or broken.
  it("declares the history its Talk offers", () => {
    expect(makeEmailDescriptor(makeDeps(makeProvider())).capabilities.talker?.history).toBe(true);
  });

  it("forwards fetchHistory and saveIncomingAttachments", async () => {
    const provider = makeProvider();
    const h = buildTalker(provider);
    h.start();

    expect(h.talker.history).toBeDefined();
    expect(h.talker.inboundMedia).toBeDefined();
    const history = await h.talker.history?.query({ limit: 20 });
    expect(Array.isArray(history)).toBe(true);
  });
});

/** A talker whose ingress and deliveries the test drives directly. */
function buildDeliveringTalker(provider: MailProvider): {
  talker: Talker;
  delivered: ChannelMessage[];
  ingest: (event: RomeMailEvent) => Promise<unknown>;
} {
  const desc = makeEmailDescriptor(makeDeps(provider));
  let ingress: ((input: unknown) => Promise<unknown>) | undefined;
  const talker = desc.capabilities.talker!.build(
    { inbox: validCred() },
    {
      connectionId: "email-test",
      persist: async () => {},
      registerIngress: (handler) => {
        ingress = handler;
        return () => {};
      },
    },
  );
  const delivered: ChannelMessage[] = [];
  talker.start(
    (msg) => delivered.push(msg),
    () => {},
  );
  return {
    talker,
    delivered,
    ingest: async (event) => {
      const rawBody = JSON.stringify(event);
      return ingress?.({ rawBody, signature: sign(rawBody) });
    },
  };
}

describe("email inbound delivery", () => {
  let sandboxHome: string;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "rome-email-integration-"));
    rs.stubEnv("HOME", sandboxHome);
    rs.stubEnv("ROME_PROFILE", "email-test");
  });

  afterEach(async () => {
    rs.unstubAllEnvs();
    rs.unstubAllGlobals();
    await rm(sandboxHome, { recursive: true, force: true });
  });

  // An authenticated email with a subject and one attachment, so every field
  // email sets is present.
  const event = buildEvent({
    hasAttachment: true,
    attachments: [{ blobId: "att_1", name: "doc.pdf", size: 3, type: "application/pdf" }],
  });

  it("delivers the transport's ChannelMessage as it is, field for field", async () => {
    const h = buildDeliveringTalker(makeProvider());

    await h.ingest(event);

    expect(h.delivered).toStrictEqual([
      {
        channel: "email",
        direction: "inbound",
        messageId: "msg_1",
        conversationId: "t1",
        senderId: GUARDIAN,
        senderDisplayName: "Guardian",
        text: "hello from the full body",
        attachments: [{ type: "document", mimeType: "application/pdf", fileName: "doc.pdf" }],
        timestamp: new Date(0),
        thread: { kind: "dm", name: "Hi" },
        raw: event,
      },
    ]);
  });

  it("materializes the attachments of a message it delivered", async () => {
    rs.stubGlobal(
      "fetch",
      rs.fn(async () => new Response(Buffer.from("pdf"), { status: 200 })),
    );
    const getAttachment = rs.fn(async (_messageId: string, _attachmentId: string) => ({
      downloadUrl: "https://files.example/presigned",
      expiresAt: new Date(0).toISOString(),
      size: 3,
    }));
    const h = buildDeliveringTalker(makeProvider({ getAttachment }));
    await h.ingest(event);

    const saved = await h.talker.inboundMedia!.materialize(h.delivered[0]);

    expect(getAttachment).toHaveBeenCalledWith("msg_1", "att_1");
    expect(saved[0].localPath).toContain(join("channel-attachments", "email", "t1", "msg_1"));
  });

  it("returns the attachments unchanged for a message it never ingested", async () => {
    const getAttachment = rs.fn(async () => {
      throw new Error("should not be called");
    });
    const h = buildDeliveringTalker(makeProvider({ getAttachment }));
    const attachments = [{ type: "document" as const, fileName: "doc.pdf" }];

    const saved = await h.talker.inboundMedia!.materialize({
      channel: "email",
      direction: "inbound",
      messageId: "msg_unknown",
      conversationId: "t1" as ConversationId,
      senderId: GUARDIAN,
      text: "",
      attachments,
      timestamp: new Date(0),
    });

    expect(saved).toBe(attachments);
    expect(getAttachment).not.toHaveBeenCalled();
  });
});

describe("email descriptor over a real ConnectionRegistry", () => {
  it("reports needs-auth for talk before the inbox grant is imported", async () => {
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeEmailDescriptor(makeDeps(makeProvider())));
    const conn = await registry.connect("email");
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["inbox"] });
    expect(conn.talk).toBeNull();
  });

  it("unlocks talk once the inbox grant is imported and delivers inbound", async () => {
    const provider = makeProvider();
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeEmailDescriptor(makeDeps(provider)));
    const conn = await registry.connect("email");
    await registry.importCredential(conn.id, "inbox", validCred());

    expect(conn.status().talk).toEqual({ state: "unlocked" });
    const talk = conn.talk!;

    const received: ChannelMessage[] = [];
    talk.subscribe(async (msg) => {
      received.push(msg);
      return;
    });

    const raw = JSON.stringify(buildEvent());
    const result = (await registry.ingest(conn.id, {
      rawBody: raw,
      signature: sign(raw),
    })) as { status: string };

    expect(result.status).toBe("dispatched");
    expect(received).toHaveLength(1);
  });

  it("degrades the inbox grant after a bad-signature deposit (setup-driven renew ⇒ re-confer)", async () => {
    const provider = makeProvider();
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(makeEmailDescriptor(makeDeps(provider)));
    const conn = await registry.connect("email");
    await registry.importCredential(conn.id, "inbox", validCred());
    const raw = JSON.stringify(buildEvent());
    const result = await registry.ingest(conn.id, {
      rawBody: raw,
      signature: "wrong-signature",
    });
    expect(result).toEqual({ status: "rejected", reason: "bad_signature" });
    await flush();

    expect(conn.talk).toBeNull();
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["inbox"] });
    expect(conn.auth.grants().inbox).toBe("degraded");
  });
});

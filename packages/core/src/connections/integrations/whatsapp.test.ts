// The WhatsApp descriptor. The transport (WhatsAppAdapter)
// is injected as a fake through `deps.createAdapter`, so these tests exercise
// the descriptor's wiring — kit.persist write-through, fault mapping, deps
// threading, migration — without a real Baileys socket.

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, ChannelMessage, MessageReceipt } from "@rome-os/app-runtime";
import {
  WhatsAppAdapter,
  type WhatsAppAuthProvider,
  type WhatsAppSocketFactory,
} from "../../channels/whatsapp.js";
import type { WhatsAppSyncSink } from "../../channels/whatsapp-sync.js";
import { createTestDb } from "../../test/helpers.js";
import { CredentialRejected, Disconnected } from "../errors.js";
import { DrizzleGrantLedger } from "../ledger-db.js";
import { ConnectionRegistry } from "../registry.js";
import type { Connection, Credential, RuntimeKit, SecretRecord, StreamFault } from "../types.js";
import { createWhatsAppDescriptor, importWhatsAppSessionFromDirectory } from "./whatsapp.js";
import { createWhatsAppAuthState } from "./whatsapp-auth-state.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

/**
 * A fake WhatsAppAdapter. Records the injected deps + captures every callback so
 * a test can drive `onFault` / `onConnected` / inbound delivery, and threads the
 * auth provider so `saveCreds` write-through can be exercised.
 */
class FakeWhatsAppAdapter {
  authProvider!: WhatsAppAuthProvider;
  sync: WhatsAppSyncSink | null = null;
  connectedCb: ((jid: string) => void) | null = null;
  faultCb: ((f: { kind: "loggedOut" | "terminal"; cause?: unknown }) => void) | null = null;
  messageCb: ((m: ChannelMessage) => Promise<void>) | null = null;
  started = false;
  stopped = false;
  startError: unknown = null;
  readonly sent: Array<{ conversationId: ConversationId; msg: unknown }> = [];

  onSync(sink: WhatsAppSyncSink): void {
    this.sync = sink;
  }
  onConnected(cb: (jid: string) => void): void {
    this.connectedCb = cb;
  }
  onFault(cb: (f: { kind: "loggedOut" | "terminal"; cause?: unknown }) => void): void {
    this.faultCb = cb;
  }
  onInbound(cb: (m: ChannelMessage) => Promise<void>): void {
    this.messageCb = cb;
  }
  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async send(conversationId: ConversationId, msg: unknown): Promise<MessageReceipt> {
    this.sent.push({ conversationId, msg });
    return { conversationId, messageId: "sent-1" };
  }
  async saveIncomingAttachments(m: ChannelMessage) {
    return m.attachments;
  }
}

function makeDeps(fake: FakeWhatsAppAdapter) {
  const sync: WhatsAppSyncSink = {
    async upsertContacts() {},
    async upsertChats() {},
    async upsertMessages() {},
  };
  const mapped: string[] = [];
  const deps = {
    syncSink: sync,
    onGuardianConnected: (jid: string) => mapped.push(jid),
    createAdapter: (authProvider: WhatsAppAuthProvider) => {
      fake.authProvider = authProvider;
      return fake as unknown as WhatsAppAdapter;
    },
  };
  return { deps, mapped, sync };
}

const runtimeKit = (persist: RuntimeKit["persist"] = async () => {}): RuntimeKit => ({
  connectionId: "whatsapp-test",
  persist,
  registerIngress: () => () => {},
});

/** Minimal session material: empty strings → createWhatsAppAuthState uses
 *  initAuthCreds()/{} (the descriptor asSessionMaterial default path). */
const sessionCred = (): Credential => ({
  material: { creds: "", keys: "" },
  expiresAt: "never",
});

describe("whatsapp descriptor shape", () => {
  it("declares one `session` grant and a talker needing it", () => {
    const { deps } = makeDeps(new FakeWhatsAppAdapter());
    const desc = createWhatsAppDescriptor(deps);
    expect(desc.service).toBe("whatsapp");
    expect(Object.keys(desc.auth)).toEqual(["session"]);
    expect(desc.capabilities.talker?.needs).toEqual(["session"]);
    expect(desc.capabilities.actor).toBeUndefined();
    expect(desc.capabilities.watcher).toBeUndefined();
  });

  it("setup-driven scheme: confer throws, renew is re-confer", async () => {
    const { deps } = makeDeps(new FakeWhatsAppAdapter());
    const scheme = createWhatsAppDescriptor(deps).auth.session;
    await expect(scheme.confer({ prompt: async () => ({}) })).rejects.toThrow(
      "conferral driven by the connection setup",
    );
    await expect(scheme.renew(sessionCred())).resolves.toBe("re-confer");
  });

  it("threads the store sink + guardian-map callback into the adapter", () => {
    const fake = new FakeWhatsAppAdapter();
    const { deps, mapped, sync } = makeDeps(fake);
    const desc = createWhatsAppDescriptor(deps);
    desc.capabilities.talker!.build({ session: sessionCred() }, runtimeKit());

    expect(fake.sync).toBe(sync);
    fake.connectedCb?.("15550100@s.whatsapp.net");
    expect(mapped).toEqual(["15550100@s.whatsapp.net"]);
  });

  it("forwards saveIncomingAttachments and awaits stop()", async () => {
    const fake = new FakeWhatsAppAdapter();
    const { deps } = makeDeps(fake);
    const talker = createWhatsAppDescriptor(deps).capabilities.talker!.build(
      { session: sessionCred() },
      runtimeKit(),
    );
    talker.start(
      () => {},
      () => {},
    );
    const message = {
      channel: "whatsapp",
      direction: "inbound",
      messageId: "message-1",
      conversationId: "chat-1@s.whatsapp.net" as ConversationId,
      senderId: "user-1",
      text: "hi",
      attachments: [],
      timestamp: new Date(),
    } satisfies ChannelMessage;
    await expect(talker.inboundMedia?.materialize(message)).resolves.toEqual([]);
    await talker.stop();
    expect(fake.stopped).toBe(true);
  });

  // What was said is the channel's `messages`, read from the mirror
  // (whatsapp-messages.ts). The Talk no longer reads history of its own.
  it("leaves history to the channel", async () => {
    const fake = new FakeWhatsAppAdapter();
    const { deps } = makeDeps(fake);
    const talker = createWhatsAppDescriptor(deps).capabilities.talker!.build(
      { session: sessionCred() },
      runtimeKit(),
    );
    expect(talker.history).toBeUndefined();
    expect(createWhatsAppDescriptor(deps).capabilities.talker?.history).toBeUndefined();
  });
});

describe("whatsapp descriptor — kit.persist write-through", () => {
  it("persists the session material when the adapter's auth state mutates", async () => {
    const fake = new FakeWhatsAppAdapter();
    const { deps } = makeDeps(fake);
    const persist = rs.fn(async (_grant: string, _material: SecretRecord) => {});
    const kit = runtimeKit(persist);
    const talker = createWhatsAppDescriptor(deps).capabilities.talker!.build(
      { session: sessionCred() },
      kit,
    );
    talker.start(
      () => {},
      () => {},
    );

    // Simulate Baileys rotating a key via the injected auth provider's state.
    const { state, saveCreds } = await fake.authProvider();
    await state.keys.set({ session: { "u@s.whatsapp.net": new Uint8Array([1, 2]) } });
    await saveCreds();
    await flush();

    expect(persist).toHaveBeenCalled();
    const [grant, material] = persist.mock.calls[0];
    expect(grant).toBe("session");
    expect(
      JSON.parse((material as { keys: string }).keys).session["u@s.whatsapp.net"],
    ).toBeTruthy();
  });

  it("flush()es the final rotation on stop (no loss)", async () => {
    const fake = new FakeWhatsAppAdapter();
    const { deps } = makeDeps(fake);
    const persist = rs.fn(async (_grant: string, _material: SecretRecord) => {});
    const talker = createWhatsAppDescriptor(deps).capabilities.talker!.build(
      { session: sessionCred() },
      runtimeKit(persist),
    );
    talker.start(
      () => {},
      () => {},
    );
    const { state } = await fake.authProvider();
    // A rotation lands, then stop() runs before the debounce fires on its own.
    void state.keys.set({ session: { last: new Uint8Array([9]) } });
    await talker.stop();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.parse(persist.mock.calls[0][1].keys).session.last).toBeTruthy();
  });
});

describe("whatsapp Talker fault mapping", () => {
  function buildTalker(fake: FakeWhatsAppAdapter): { faults: StreamFault[] } {
    const { deps } = makeDeps(fake);
    const talker = createWhatsAppDescriptor(deps).capabilities.talker!.build(
      { session: sessionCred() },
      runtimeKit(),
    );
    const faults: StreamFault[] = [];
    talker.start(
      () => {},
      (err) => faults.push(err),
    );
    return { faults };
  }

  it("maps loggedOut to CredentialRejected{ grant: 'session' }", () => {
    const fake = new FakeWhatsAppAdapter();
    const { faults } = buildTalker(fake);
    fake.faultCb?.({ kind: "loggedOut", cause: new Error("device unlinked") });
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(CredentialRejected);
    expect((faults[0] as CredentialRejected).grant).toBe("session");
  });

  it("maps a non-loggedOut terminal to Disconnected (not a credential fault)", () => {
    const fake = new FakeWhatsAppAdapter();
    const { faults } = buildTalker(fake);
    fake.faultCb?.({ kind: "terminal", cause: new Error("stream errored") });
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(Disconnected);
    expect(faults[0]).not.toBeInstanceOf(CredentialRejected);
  });

  it("maps a fatal start() error to Disconnected", async () => {
    const fake = new FakeWhatsAppAdapter();
    fake.startError = new Error("socket build failed");
    const { faults } = buildTalker(fake);
    await flush();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(Disconnected);
  });
});

describe("whatsapp descriptor over a real registry", () => {
  function setup(fake: FakeWhatsAppAdapter): ConnectionRegistry {
    const { deps } = makeDeps(fake);
    const registry = new ConnectionRegistry({ ledger: makeLedger() });
    registry.register(createWhatsAppDescriptor(deps));
    return registry;
  }

  it("reports needs-auth before the session grant is conferred", async () => {
    const registry = setup(new FakeWhatsAppAdapter());
    const conn = await registry.connect("whatsapp");
    expect(conn.status().talk).toEqual({ state: "needs-auth", missingGrants: ["session"] });
    expect(conn.talk).toBeNull();
  });

  it("unlocks talk once the session is imported and round-trips send()", async () => {
    const fake = new FakeWhatsAppAdapter();
    const registry = setup(fake);
    const conn = await registry.connect("whatsapp");
    await registry.importCredential(conn.id, "session", sessionCred());

    expect(conn.status().talk).toEqual({ state: "unlocked" });
    // WhatsAppAdapter.send addresses by the conversation (the chat JID), and
    // its receipt is the Talk's as it is.
    const receipt = await conn.talk!.send("120@g.us" as ConversationId, { text: "hi" });
    expect(fake.sent).toEqual([{ conversationId: "120@g.us", msg: { text: "hi" } }]);
    expect(receipt).toStrictEqual({ conversationId: "120@g.us", messageId: "sent-1" });
  });
});

// A real WhatsAppAdapter over a fake Baileys socket, so the delivered message
// is the transport's own record rather than a fake's.
describe("whatsapp inbound delivery", () => {
  function realTalker() {
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const socketFactory = (() => ({
      ev: {
        on(event: string, handler: (payload: unknown) => unknown) {
          handlers.set(event, handler);
        },
      },
      end: () => {},
      sendMessage: async () => undefined,
      user: undefined,
    })) as unknown as WhatsAppSocketFactory;
    const talker = createWhatsAppDescriptor({
      syncSink: {
        async upsertContacts() {},
        async upsertChats() {},
        async upsertMessages() {},
      },
      onGuardianConnected: () => {},
      createAdapter: (authProvider) => new WhatsAppAdapter({ authProvider }, socketFactory),
    }).capabilities.talker!.build({ session: sessionCred() }, runtimeKit());
    return { talker, handlers };
  }

  it("delivers the transport's ChannelMessage as it is, field for field", async () => {
    const { talker, handlers } = realTalker();
    const delivered: unknown[] = [];
    talker.start(
      (msg) => delivered.push(msg),
      () => {},
    );
    await rs.waitFor(() => expect(handlers.has("messages.upsert")).toBe(true));

    // A group message from a device-suffixed participant carrying a document,
    // so the sender is canonicalized and an attachment is extracted.
    const waMsg = {
      key: {
        remoteJid: "120363000000@g.us",
        id: "wa-7",
        fromMe: false,
        participant: "15550001111:3@s.whatsapp.net",
      },
      pushName: "Alice",
      messageTimestamp: 1700000000,
      message: {
        documentMessage: {
          mimetype: "application/pdf",
          fileName: "a.pdf",
          caption: "see this",
        },
      },
    };
    await handlers.get("messages.upsert")!({ messages: [waMsg] });

    expect(delivered).toStrictEqual([
      {
        channel: "whatsapp",
        direction: "inbound",
        messageId: "wa-7",
        conversationId: "120363000000@g.us",
        senderId: "15550001111@s.whatsapp.net",
        senderDisplayName: "Alice",
        text: "see this",
        attachments: [
          {
            type: "document",
            mimeType: "application/pdf",
            fileName: "a.pdf",
            caption: "see this",
          },
        ],
        timestamp: new Date(1700000000 * 1000),
        thread: { kind: "group" },
        raw: waMsg,
      },
    ]);
    await talker.stop();
  });

  it("materialize keeps the attachments unsaved when the message carries no raw", async () => {
    const { talker } = realTalker();
    const message = {
      channel: "whatsapp",
      direction: "inbound",
      messageId: "wa-8",
      conversationId: "15550001111@s.whatsapp.net" as ConversationId,
      senderId: "15550001111@s.whatsapp.net",
      text: "",
      attachments: [{ type: "image", mimeType: "image/jpeg" }],
      timestamp: new Date(),
    } satisfies ChannelMessage;

    await expect(talker.inboundMedia?.materialize(message)).resolves.toBe(message.attachments);
  });
});

describe("importWhatsAppSessionFromDirectory (migration helper)", () => {
  function fakeConnection(sessionState: "unauthorized" | "authorized" | "degraded"): Connection {
    return {
      auth: { grants: () => ({ session: sessionState }) },
    } as unknown as Connection;
  }

  it("imports serialized material read from a legacy directory", async () => {
    // A directory the migration reader turns into non-null material.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { BufferJSON, initAuthCreds } = await import("@whiskeysockets/baileys");
    const dir = await mkdtemp(join(tmpdir(), "rome-wa-mig-"));
    try {
      await writeFile(
        join(dir, "creds.json"),
        JSON.stringify(initAuthCreds(), BufferJSON.replacer),
      );

      const imported: Array<{ grant: string; cred: Credential }> = [];
      await importWhatsAppSessionFromDirectory({
        connection: fakeConnection("unauthorized"),
        authStatePath: dir,
        importCredential: async (grant, cred) => {
          imported.push({ grant, cred });
        },
      });

      expect(imported).toHaveLength(1);
      expect(imported[0].grant).toBe("session");
      // The imported material rehydrates into a working auth state.
      const material = imported[0].cred.material as { creds: string; keys: string };
      const auth = createWhatsAppAuthState(material, async () => {});
      expect(typeof auth.state.creds.registrationId).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "authorized",
    "degraded",
  ] as const)("ledger wins: no import when the session is already %s", async (sessionState) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { BufferJSON, initAuthCreds } = await import("@whiskeysockets/baileys");
    const dir = await mkdtemp(join(tmpdir(), "rome-wa-mig-"));
    try {
      await writeFile(
        join(dir, "creds.json"),
        JSON.stringify(initAuthCreds(), BufferJSON.replacer),
      );
      const imported: unknown[] = [];
      await importWhatsAppSessionFromDirectory({
        connection: fakeConnection(sessionState),
        authStatePath: dir,
        importCredential: async (grant, cred) => {
          imported.push({ grant, cred });
        },
      });
      expect(imported).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no directory → no import", async () => {
    const imported: unknown[] = [];
    await importWhatsAppSessionFromDirectory({
      connection: fakeConnection("unauthorized"),
      authStatePath: "/tmp/definitely-not-a-wa-dir-xyz",
      importCredential: async (grant, cred) => {
        imported.push({ grant, cred });
      },
    });
    expect(imported).toHaveLength(0);
  });
});

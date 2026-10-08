import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { WhatsAppAdapter } from "./whatsapp.js";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type {
  WhatsAppSyncSink,
  WaContactInput,
  WaChatInput,
  WaMessageInput,
} from "./whatsapp-sync.js";

// Mock @whiskeysockets/baileys

const mockSendMessage = rs.fn();
const mockEnd = rs.fn();
const mockRequestPairingCode = rs.fn();
const mockDownloadMediaMessage = rs.hoisted(() => rs.fn());
const profileMemoryDir = rs.hoisted(() => ({ value: "" }));

rs.mock("../paths.js", () => ({
  getProfileMemoryDir: () => profileMemoryDir.value,
}));

// Event handlers registered via sock.ev.on()
const eventHandlers: Record<string, (...args: unknown[]) => void> = {};

const mockSock = {
  ev: {
    on: rs.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers[event] = handler;
    }),
  },
  sendMessage: mockSendMessage,
  requestPairingCode: mockRequestPairingCode,
  end: mockEnd,
  user: { id: "1234567890@s.whatsapp.net" } as {
    id: string;
    lid?: string;
    name?: string;
  },
};

const mockSaveCreds = rs.fn();

// Faithful re-implementations of Baileys' JID helpers (the real module pulls in
// libsignal + native deps, so we don't importActual it). These mirror
// WABinary/jid-utils: strip the `:device`/`_agent` suffix, keep the server, and
// compare users by number only.
function decodeUser(jid?: string): string | undefined {
  return jid?.split("@")[0]?.split(":")[0]?.split("_")[0];
}

rs.mock("@whiskeysockets/baileys", () => {
  return {
    default: rs.fn(() => mockSock),
    useMultiFileAuthState: rs.fn(() =>
      Promise.resolve({
        state: { creds: {}, keys: {} },
        saveCreds: mockSaveCreds,
      }),
    ),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: mockDownloadMediaMessage,
    jidNormalizedUser: (jid?: string) => {
      if (!jid) return "";
      const server = jid.slice(jid.indexOf("@") + 1);
      return `${decodeUser(jid)}@${server === "c.us" ? "s.whatsapp.net" : server}`;
    },
    areJidsSameUser: (a?: string, b?: string) => decodeUser(a) === decodeUser(b),
    isJidGroup: (jid?: string) => jid?.endsWith("@g.us"),
  };
});

// Helpers

function makeWAMessage(overrides: Record<string, unknown> = {}) {
  return {
    key: {
      remoteJid: "1234567890@s.whatsapp.net",
      id: "wa-msg-001",
      fromMe: false,
      participant: undefined,
      ...((overrides.key as Record<string, unknown>) ?? {}),
    },
    pushName: "Bob",
    messageTimestamp: 1700000000,
    message: {
      conversation: "hello from whatsapp",
      ...((overrides.message as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => !["key", "message"].includes(k)),
    ),
  };
}

// Tests

describe("WhatsAppAdapter", () => {
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    rs.clearAllMocks();
    // Clear event handlers
    for (const key of Object.keys(eventHandlers)) {
      delete eventHandlers[key];
    }
    profileMemoryDir.value = await mkdtemp(join(tmpdir(), "rome-whatsapp-"));
    adapter = new WhatsAppAdapter({ authStatePath: "/tmp/auth" });
  });

  afterEach(async () => {
    rs.useRealTimers();
    await rm(profileMemoryDir.value, { recursive: true, force: true });
  });

  describe("inbound messages", () => {
    it("emits a private message as the channel's record, with the WAMessage as raw", async () => {
      let captured: ChannelMessage | undefined;
      adapter.onInbound(async (msg) => {
        captured = msg;
      });
      await adapter.start();
      const waMsg = makeWAMessage();

      // Trigger the messages.upsert event
      await eventHandlers["messages.upsert"]({
        messages: [waMsg],
      });

      expect(captured).toStrictEqual({
        channel: "whatsapp",
        direction: "inbound",
        messageId: "wa-msg-001",
        conversationId: "1234567890@s.whatsapp.net",
        senderId: "1234567890@s.whatsapp.net",
        senderDisplayName: "Bob",
        text: "hello from whatsapp",
        attachments: [],
        timestamp: new Date(1700000000 * 1000),
        thread: { kind: "dm" },
        raw: waMsg,
      });
    });

    it("emits a group message with the participant as sender", async () => {
      let captured: ChannelMessage | undefined;
      adapter.onInbound(async (msg) => {
        captured = msg;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: {
              remoteJid: "group123@g.us",
              id: "wa-msg-002",
              fromMe: false,
              participant: "sender@s.whatsapp.net",
            },
          }),
        ],
      });

      expect(captured!.thread).toEqual({ kind: "group" });
      expect(captured!.conversationId).toBe("group123@g.us");
      expect(captured!.senderId).toBe("sender@s.whatsapp.net");
    });

    it("extracts image attachments", async () => {
      let captured: ChannelMessage | undefined;
      adapter.onInbound(async (msg) => {
        captured = msg;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            message: {
              imageMessage: {
                mimetype: "image/jpeg",
                caption: "photo caption",
              },
            },
          }),
        ],
      });

      expect(captured!.attachments).toHaveLength(1);
      expect(captured!.attachments[0]).toEqual({
        type: "image",
        mimeType: "image/jpeg",
        caption: "photo caption",
      });
    });

    it("extracts document attachments", async () => {
      let captured: ChannelMessage | undefined;
      adapter.onInbound(async (msg) => {
        captured = msg;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            message: {
              documentMessage: {
                mimetype: "application/pdf",
                fileName: "report.pdf",
                caption: "the report",
              },
            },
          }),
        ],
      });

      expect(captured!.attachments).toHaveLength(1);
      expect(captured!.attachments[0]).toEqual({
        type: "document",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        caption: "the report",
      });
    });

    it("uses remoteJid as senderId for private chats", async () => {
      let captured: ChannelMessage | undefined;
      adapter.onInbound(async (msg) => {
        captured = msg;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: {
              remoteJid: "5551234@s.whatsapp.net",
              id: "wa-msg-003",
              fromMe: false,
            },
          }),
        ],
      });

      // Private: senderId === remoteJid
      expect(captured!.senderId).toBe("5551234@s.whatsapp.net");
    });
  });

  describe("address-book sync", () => {
    function makeSink() {
      const calls = {
        contacts: [] as WaContactInput[],
        chats: [] as WaChatInput[],
        messages: [] as WaMessageInput[],
      };
      const sink: WhatsAppSyncSink = {
        async upsertContacts(c) {
          calls.contacts.push(...c);
        },
        async upsertChats(c) {
          calls.chats.push(...c);
        },
        async upsertMessages(m) {
          calls.messages.push(...m);
        },
      };
      return { sink, calls };
    }

    it("persists contacts, chats, and messages from the initial history sync", async () => {
      const { sink, calls } = makeSink();
      adapter.onSync(sink);
      await adapter.start();

      eventHandlers["messaging-history.set"]({
        contacts: [{ id: "111@s.whatsapp.net", name: "Alice", notify: "Ali", phoneNumber: "111" }],
        chats: [{ id: "111@s.whatsapp.net", name: "Alice", conversationTimestamp: 1700000000 }],
        messages: [
          makeWAMessage({ key: { remoteJid: "111@s.whatsapp.net", id: "h1", fromMe: false } }),
        ],
        progress: 50,
      });

      expect(calls.contacts).toHaveLength(1);
      expect(calls.contacts[0]).toMatchObject({
        jid: "111@s.whatsapp.net",
        name: "Alice",
        notify: "Ali",
      });
      expect(calls.chats[0]).toMatchObject({ jid: "111@s.whatsapp.net", isGroup: false });
      expect(calls.messages[0]).toMatchObject({
        id: "h1",
        chatJid: "111@s.whatsapp.net",
        text: "hello from whatsapp",
      });
    });

    it("mirrors our own outbound messages even though the agent pipeline skips them", async () => {
      const { sink, calls } = makeSink();
      let handled = false;
      adapter.onSync(sink);
      adapter.onInbound(async () => {
        handled = true;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({ key: { remoteJid: "111@s.whatsapp.net", id: "own1", fromMe: true } }),
        ],
      });

      expect(handled).toBe(false); // agent pipeline ignores fromMe
      expect(calls.messages).toHaveLength(1);
      expect(calls.messages[0]).toMatchObject({ id: "own1", fromMe: true });
    });

    it("stores a reaction as an emoji pinned to its target, off the agent pipeline", async () => {
      const { sink, calls } = makeSink();
      let handled = false;
      adapter.onSync(sink);
      adapter.onInbound(async () => {
        handled = true;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "r1", fromMe: false },
            message: { reactionMessage: { key: { id: "target-1" }, text: "❤️" } },
          }),
          // An empty emoji is a reaction removal — dropped, never stored.
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "r2", fromMe: false },
            message: { reactionMessage: { key: { id: "target-1" }, text: "" } },
          }),
        ],
      });

      expect(handled).toBe(false); // a reaction is not an inbound turn
      expect(calls.messages).toHaveLength(1); // removal dropped
      expect(calls.messages[0]).toMatchObject({
        id: "r1",
        type: "reaction",
        text: "❤️",
        reactsToId: "target-1",
      });
    });

    it("drops contentless protocol frames instead of mirroring empty bubbles", async () => {
      const { sink, calls } = makeSink();
      const handledIds: string[] = [];
      adapter.onSync(sink);
      adapter.onInbound(async (m) => {
        handledIds.push(m.messageId);
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          // A real text turn is mirrored and handled as usual.
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "real1", fromMe: false },
          }),
          // Sender-key distribution / app-state frames arrive in a burst at
          // connect time with no renderable content — neither stored nor handled.
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "proto1", fromMe: false },
            message: { conversation: undefined, senderKeyDistributionMessage: { groupId: "g" } },
          }),
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "proto2", fromMe: false },
            message: { conversation: undefined, protocolMessage: { type: 3 } },
          }),
        ],
      });

      expect(handledIds).toEqual(["real1"]); // protocol frames never reach the agent
      expect(calls.messages).toHaveLength(1);
      expect(calls.messages[0]).toMatchObject({ id: "real1", type: "text" });
    });

    it("keeps visible WhatsApp payloads that do not have first-class renderers yet", async () => {
      const { sink, calls } = makeSink();
      const handled: ChannelMessage[] = [];
      adapter.onSync(sink);
      adapter.onInbound(async (m) => {
        handled.push(m);
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "loc1", fromMe: false },
            message: {
              conversation: undefined,
              locationMessage: { name: "Cafe Roma", address: "12 Main St" },
            },
          }),
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "contact1", fromMe: false },
            message: {
              conversation: undefined,
              contactMessage: { displayName: "Alice Example" },
            },
          }),
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "poll1", fromMe: false },
            message: {
              conversation: undefined,
              pollCreationMessage: { name: "Lunch?", options: [{ optionName: "Pizza" }] },
            },
          }),
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "unknown1", fromMe: false },
            message: {
              conversation: undefined,
              placeholderMessage: { type: 1 },
            },
          }),
        ],
      });

      expect(handled.map((m) => [m.messageId, m.text])).toEqual([
        ["loc1", "Location: Cafe Roma"],
        ["contact1", "Contact: Alice Example"],
        ["poll1", "Poll: Lunch?"],
        ["unknown1", "Unsupported WhatsApp placeholder message"],
      ]);
      expect(calls.messages.map((m) => [m.id, m.type, m.text])).toEqual([
        ["loc1", "location", "Location: Cafe Roma"],
        ["contact1", "contact", "Contact: Alice Example"],
        ["poll1", "poll", "Poll: Lunch?"],
        ["unknown1", "unsupported", "Unsupported WhatsApp placeholder message"],
      ]);
    });

    it("unwraps view-once and ephemeral containers before summarizing content", async () => {
      const { sink, calls } = makeSink();
      let handled: ChannelMessage | undefined;
      adapter.onSync(sink);
      adapter.onInbound(async (m) => {
        handled = m;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: { remoteJid: "111@s.whatsapp.net", id: "wrapped1", fromMe: false },
            message: {
              conversation: undefined,
              viewOnceMessage: {
                message: {
                  imageMessage: {
                    mimetype: "image/jpeg",
                    caption: "secret-ish photo",
                  },
                },
              },
            },
          }),
        ],
      });

      expect(handled?.text).toBe("secret-ish photo");
      expect(handled?.attachments).toEqual([
        { type: "image", mimeType: "image/jpeg", caption: "secret-ish photo" },
      ]);
      expect(calls.messages[0]).toMatchObject({
        id: "wrapped1",
        type: "image",
        text: "secret-ish photo",
        hasMedia: true,
      });
    });

    it("upserts contacts from contacts.upsert", async () => {
      const { sink, calls } = makeSink();
      adapter.onSync(sink);
      await adapter.start();

      eventHandlers["contacts.upsert"]([
        { id: "222@s.whatsapp.net", name: "Bob" },
        { id: "lid-contact@lid", phoneNumber: "15551234567@s.whatsapp.net" },
      ]);

      expect(calls.contacts[0]).toMatchObject({ jid: "222@s.whatsapp.net", name: "Bob" });
      expect(calls.contacts[0].phoneNumber).toBe("222");
      expect(calls.contacts[1]).toMatchObject({
        jid: "lid-contact@lid",
        phoneNumber: "15551234567",
      });
    });

    it("does not persist when no sync sink is registered", async () => {
      await adapter.start();
      // Should not throw without a sink wired.
      expect(() =>
        eventHandlers["contacts.upsert"]([{ id: "222@s.whatsapp.net", name: "Bob" }]),
      ).not.toThrow();
    });
  });

  describe("connection handling", () => {
    it("waits for the registration QR event before requesting a pairing code", async () => {
      rs.useFakeTimers();
      mockRequestPairingCode.mockResolvedValue("ABCD1234");
      await adapter.start();

      const code = adapter.requestPairingCode("14155550134");
      expect(mockRequestPairingCode).not.toHaveBeenCalled();

      eventHandlers["connection.update"]({ qr: "registration-ready" });
      await rs.advanceTimersByTimeAsync(750);

      await expect(code).resolves.toBe("ABCD1234");
      expect(mockRequestPairingCode).toHaveBeenCalledWith("14155550134");
    });

    it("rejects pairing-code requests for credentials that are already registered", async () => {
      const registeredAdapter = new WhatsAppAdapter({
        authProvider: async () => ({
          state: { creds: { registered: true }, keys: {} } as never,
          saveCreds: rs.fn(),
        }),
      });
      await registeredAdapter.start();

      await expect(registeredAdapter.requestPairingCode("14155550134")).rejects.toThrow(
        "This WhatsApp session is already paired; use the normal connection flow",
      );
      expect(mockRequestPairingCode).not.toHaveBeenCalled();
    });

    it("reconnects on non-logout disconnect", async () => {
      rs.useFakeTimers();
      await adapter.start();

      const connectionHandler = eventHandlers["connection.update"];
      expect(connectionHandler).toBeDefined();

      // Simulate a close with a non-logout status code
      connectionHandler({
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: 500 },
            message: "connection lost",
          },
        },
      });

      // The adapter should schedule a reconnect via setTimeout
      // Advance timers to trigger it
      rs.advanceTimersByTime(1_000);
      // The reconnect calls start() again, which calls makeWASocket
      // We just verify it doesn't throw
      rs.useRealTimers();
    });
  });

  describe("own message filtering", () => {
    it("skips messages with fromMe=true", async () => {
      let captured: ChannelMessage | undefined;
      adapter.onInbound(async (msg) => {
        captured = msg;
      });
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: {
              remoteJid: "1234567890@s.whatsapp.net",
              id: "wa-msg-own",
              fromMe: true,
            },
          }),
        ],
      });

      expect(captured).toBeUndefined();
    });
  });

  describe("onConnected()", () => {
    it("fires callback with authenticated JID on connection open", async () => {
      const callback = rs.fn();
      adapter.onConnected(callback);
      await adapter.start();

      const connectionHandler = eventHandlers["connection.update"];
      connectionHandler({ connection: "open" });

      expect(callback).toHaveBeenCalledWith("1234567890@s.whatsapp.net");
    });

    it("strips the device suffix so the guardian maps onto the canonical self JID", async () => {
      const originalUser = mockSock.user;
      mockSock.user = { id: "1234567890:8@s.whatsapp.net" };
      try {
        const callback = rs.fn();
        adapter.onConnected(callback);
        await adapter.start();

        eventHandlers["connection.update"]({ connection: "open" });

        expect(callback).toHaveBeenCalledWith("1234567890@s.whatsapp.net");
      } finally {
        mockSock.user = originalUser;
      }
    });

    it("does not crash if no callback registered", async () => {
      await adapter.start();

      const connectionHandler = eventHandlers["connection.update"];
      expect(() => connectionHandler({ connection: "open" })).not.toThrow();
    });
  });

  describe("send()", () => {
    const CHAT = "jid@s.whatsapp.net" as ConversationId;

    it("sends a text message via the socket and returns its receipt", async () => {
      mockSendMessage.mockResolvedValueOnce({ key: { id: "sent-1" } });
      await adapter.start();
      const receipt = await adapter.send(CHAT, {
        text: "hi from bot",
      });

      expect(mockSendMessage).toHaveBeenCalledWith("jid@s.whatsapp.net", {
        text: "hi from bot",
      });
      expect(receipt).toStrictEqual({ conversationId: CHAT, messageId: "sent-1" });
    });

    it("leaves messageId out of the receipt when the socket returns none", async () => {
      await adapter.start();
      const receipt = await adapter.send(CHAT, { text: "hi" });

      expect(receipt).toStrictEqual({ conversationId: CHAT });
    });

    it("throws if socket is not connected", async () => {
      // Don't call start(), so sock is null
      await expect(
        adapter.send(CHAT, {
          text: "fail",
        }),
      ).rejects.toThrow("WhatsApp not connected");
    });
  });

  describe("JID canonicalization", () => {
    // Self has a device-suffixed phone id and a separate LID address — the two
    // unrelated user numbers WhatsApp uses for "me".
    const SELF_PHONE = "15550101000";
    const SELF_PN = `${SELF_PHONE}@s.whatsapp.net`;
    const SELF_DEVICE_PN = `${SELF_PHONE}:7@s.whatsapp.net`;
    const originalUser = mockSock.user;

    function makeSink() {
      const calls = {
        contacts: [] as WaContactInput[],
        chats: [] as WaChatInput[],
        messages: [] as WaMessageInput[],
      };
      const sink: WhatsAppSyncSink = {
        async upsertContacts(c) {
          calls.contacts.push(...c);
        },
        async upsertChats(c) {
          calls.chats.push(...c);
        },
        async upsertMessages(m) {
          calls.messages.push(...m);
        },
      };
      return { sink, calls };
    }

    beforeEach(() => {
      mockSock.user = {
        id: SELF_DEVICE_PN,
        lid: "267645534388423:7@lid",
        name: "Yunfan",
      };
    });

    afterEach(() => {
      mockSock.user = originalUser;
    });

    it("strips the device suffix from a non-self send target", async () => {
      await adapter.start();
      await adapter.send("5551234:9@s.whatsapp.net" as ConversationId, { text: "hi" });
      expect(mockSendMessage).toHaveBeenCalledWith("5551234@s.whatsapp.net", { text: "hi" });
    });

    it("routes a send to any self form onto the canonical phone-number JID", async () => {
      await adapter.start();
      for (const form of [
        SELF_PN, // bare phone
        SELF_DEVICE_PN, // device-suffixed
        "267645534388423@lid", // LID
      ]) {
        mockSendMessage.mockClear();
        await adapter.send(form as ConversationId, { text: "note" });
        expect(mockSendMessage).toHaveBeenCalledWith(SELF_PN, { text: "note" });
      }
    });

    it("folds self-chat messages from phone, device, and LID JIDs onto one chatJid", async () => {
      const { sink, calls } = makeSink();
      adapter.onSync(sink);
      await adapter.start();

      await eventHandlers["messages.upsert"]({
        messages: [
          makeWAMessage({
            key: { remoteJid: SELF_PN, id: "s1", fromMe: true },
          }),
          makeWAMessage({
            key: { remoteJid: SELF_DEVICE_PN, id: "s2", fromMe: true },
          }),
          makeWAMessage({ key: { remoteJid: "267645534388423@lid", id: "s3", fromMe: true } }),
        ],
      });

      expect(calls.messages.map((m) => m.chatJid)).toEqual([SELF_PN, SELF_PN, SELF_PN]);
    });

    it("seeds the self contact with the push name on connection open", async () => {
      const { sink, calls } = makeSink();
      adapter.onSync(sink);
      await adapter.start();

      eventHandlers["connection.update"]({ connection: "open" });

      expect(calls.contacts).toContainEqual(
        expect.objectContaining({ jid: SELF_PN, name: "Yunfan" }),
      );
    });
  });

  describe("saveIncomingAttachments()", () => {
    it("streams inbound media through the shared size limit", async () => {
      async function* mediaStream() {
        yield Buffer.from("image-");
        yield Buffer.from("data");
      }
      mockDownloadMediaMessage.mockResolvedValue(mediaStream());

      const raw = makeWAMessage({
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
            caption: "photo",
          },
        },
      });
      const attachments = await adapter.saveIncomingAttachments(imageMessage({ raw }));

      expect(mockDownloadMediaMessage).toHaveBeenCalledWith(raw, "stream", {});
      expect(attachments[0].localPath).toBeTruthy();
      // Saved under the same channel/conversation/message path as before.
      expect(attachments[0].localPath).toContain(
        join("channel-attachments", "whatsapp", "1234567890@s.whatsapp.net", "wa-msg-001"),
      );
      await expect(readFile(attachments[0].localPath!)).resolves.toEqual(Buffer.from("image-data"));
    });

    it("keeps the attachments unsaved when the message carries no raw", async () => {
      const message = imageMessage({});
      const attachments = await adapter.saveIncomingAttachments(message);

      expect(mockDownloadMediaMessage).not.toHaveBeenCalled();
      expect(attachments).toBe(message.attachments);
    });

    it("keeps the attachments unsaved when raw is not a WAMessage", async () => {
      const message = imageMessage({ raw: { channel: "whatsapp", rawEvent: null } });
      const attachments = await adapter.saveIncomingAttachments(message);

      expect(mockDownloadMediaMessage).not.toHaveBeenCalled();
      expect(attachments).toBe(message.attachments);
    });

    /** An inbound image message as this transport emits it. */
    function imageMessage(extra: { raw?: unknown }): ChannelMessage {
      return {
        channel: "whatsapp",
        direction: "inbound",
        messageId: "wa-msg-001",
        conversationId: "1234567890@s.whatsapp.net" as ConversationId,
        senderId: "1234567890@s.whatsapp.net",
        senderDisplayName: "Bob",
        timestamp: new Date("2026-05-10T00:00:00Z"),
        text: "",
        attachments: [{ type: "image", mimeType: "image/jpeg", caption: "photo" }],
        thread: { kind: "dm" },
        ...extra,
      };
    }
  });
});

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  areJidsSameUser,
  isJidGroup,
  type AuthenticationState,
  type WAMessage,
  type WASocket,
  type Contact,
  type Chat,
} from "@whiskeysockets/baileys";

import type { ProviderAdapter } from "./adapter.js";
import type { NormalizedMessage, Attachment, OutgoingMessage } from "./types.js";
import type {
  WhatsAppSyncSink,
  WaContactInput,
  WaChatInput,
  WaHistoryMessage,
  WaMessageInput,
} from "./whatsapp-sync.js";
import {
  isAttachmentTooLargeError,
  readAttachmentByteStream,
  saveIncomingAttachmentPayloads,
} from "./attachment-files.js";

import { readFile } from "node:fs/promises";
import { createLogger } from "../logger.js";

const log = createLogger("whatsapp");

const MAX_RECONNECT_DELAY_MS = 60_000;
const WA_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
const WA_SW_URL = "https://web.whatsapp.com/sw.js";
const WA_SW_HEADERS = {
  "sec-fetch-site": "none",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
let cachedWaVersion: [number, number, number] | null = null;
let cachedWaVersionAt = 0;

export type WhatsAppConnectionStatus = "disconnected" | "connecting" | "open";
type WhatsAppPairingState = "idle" | "registered" | "waiting-for-ready" | "ready";

/**
 * A source of Baileys auth state for one socket generation. Returns the state
 * the socket is built over and a `saveCreds` write-through the adapter calls on
 * every `creds.update`.
 *
 * The legacy default (`authStatePath` in the config) uses Baileys'
 * `useMultiFileAuthState` (still used by the transient pairing socket the
 * channels API drives). The registry injects a custom in-memory provider whose
 * `saveCreds` write-through is `kit.persist` (see
 * `connections/integrations/whatsapp-auth-state.ts`).
 */
export type WhatsAppAuthProvider = () => Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}>;

/** Socket-construction seam. Production uses Baileys directly; route-level
 * contract tests replace only this network boundary and keep the adapter,
 * setup coroutine, HTTP routes, and setup runtime real. */
export type WhatsAppSocketFactory = typeof makeWASocket;

export class WhatsAppAdapter implements ProviderAdapter {
  readonly channelName = "whatsapp";
  private sock: WASocket | null = null;
  private handler?: (msg: NormalizedMessage) => Promise<void>;
  private connectedCallback?: (userId: string) => void;
  private faultCallback?: (fault: { kind: "loggedOut" | "terminal"; cause?: unknown }) => void;
  private syncSink?: WhatsAppSyncSink;
  private reconnectDelay = 1_000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  // Connection state for web login
  private connectionStatus: WhatsAppConnectionStatus = "disconnected";
  private currentQr: string | null = null;
  private pairingState: WhatsAppPairingState = "idle";
  private connectedPhoneNumber: string | null = null;
  private socketGeneration = 0;

  private readonly authProvider: WhatsAppAuthProvider;

  /**
   * Two auth-state sources:
   *   - `{ authStatePath }` — legacy multi-file directory. Still used by the
   *     transient pairing socket the channels API drives, and every existing
   *     adapter test.
   *   - `{ authProvider }` — an injected provider. Each socket
   *     generation calls it for `{ state, saveCreds }`; the descriptor threads a
   *     custom in-memory state whose `saveCreds` is `kit.persist` write-through.
   */
  constructor(
    private config: { authStatePath: string } | { authProvider: WhatsAppAuthProvider },
    private readonly socketFactory: WhatsAppSocketFactory = makeWASocket,
  ) {
    this.authProvider =
      "authProvider" in config
        ? config.authProvider
        : () => useMultiFileAuthState(config.authStatePath);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connectionStatus = "connecting";
    this.currentQr = null;
    this.pairingState = "idle";
    this.connectedPhoneNumber = null;
    const generation = ++this.socketGeneration;
    // Clean up any previous socket (e.g. during reconnection)
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    const { state, saveCreds } = await this.authProvider();
    this.pairingState = state.creds.registered ? "registered" : "waiting-for-ready";

    const waVersion = await this.fetchLatestWaWebVersion();
    this.sock = this.socketFactory({
      auth: state,
      printQRInTerminal: false,
      // Request the on-link history sync. This must be true: with it false,
      // Baileys logs "History sync is disabled by config, not waiting for
      // notification" and discards the INITIAL_BOOTSTRAP blob WhatsApp sends —
      // so `messaging-history.set` never fires and the address book never
      // populates. WhatsApp only hands a linked device a bounded recent window
      // anyway (not the full archive), which matches the "recent history" goal.
      syncFullHistory: true,
      ...(waVersion ? { version: waVersion } : {}),
    });

    this.sock.ev.on("creds.update", () => {
      if (generation !== this.socketGeneration) return;
      saveCreds().catch((err) => {
        log.error("failed to save credentials", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.sock.ev.on("connection.update", (update) => {
      if (generation !== this.socketGeneration) return;
      const { connection, lastDisconnect, qr } = update;
      log.info("connection state changed", {
        connection,
        lastDisconnect: lastDisconnect?.error?.message,
        hasQr: !!qr,
      });

      if (qr) {
        this.currentQr = qr;
        if (this.pairingState === "waiting-for-ready") {
          this.pairingState = "ready";
        }
        this.connectionStatus = "connecting";
      }

      if (connection === "open") {
        this.reconnectDelay = 1_000; // reset on successful connection
        this.connectionStatus = "open";
        this.currentQr = null;
        this.pairingState = "registered";
        log.info("connected");

        // Extract phone number from user ID (format: "1234567890:12@s.whatsapp.net")
        if (this.sock?.user?.id) {
          const match = this.sock.user.id.match(/^(\d+)/);
          if (match) this.connectedPhoneNumber = match[1];
        }

        this.seedSelfContact();

        // Hand the guardian auto-mapper our *canonical* self address, not the raw
        // socket id. `user.id` carries a `:device` suffix (`<pn>:8@s.whatsapp.net`)
        // that never matches the device-stripped JIDs we persist contacts under, so
        // mapping the guardian onto it leaves the self contact unlinked in the People
        // tab and duplicated under "WhatsApp contacts".
        const selfJid = this.selfPnJid();
        if (this.connectedCallback && selfJid) {
          try {
            this.connectedCallback(selfJid);
          } catch (err) {
            log.error("onConnected callback error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (connection === "close") {
        this.connectionStatus = "disconnected";
        this.currentQr = null;
        this.pairingState = "idle";
        this.connectedPhoneNumber = null;
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect && !this.stopped) {
          log.warn("disconnected, reconnecting", { delay: this.reconnectDelay, statusCode });
          const delay = this.reconnectDelay;
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.start().catch((err) => {
              log.error("reconnection failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          // The device was unlinked WhatsApp-side: the session credential is
          // dead and no reconnect can recover it. The registry maps this to
          // CredentialRejected{ session }; the adapter's transient reconnect
          // owns every other (recoverable) disconnect above.
          log.warn("logged out, not reconnecting");
          this.faultCallback?.({ kind: "loggedOut", cause: lastDisconnect?.error });
        }
        // A `stopped` close is a graceful shutdown, not a fault — no callback.
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      if (generation !== this.socketGeneration) return;

      // Mirror every message — including our own and group traffic, both of
      // which the agent pipeline below skips — into the address-book store.
      this.persistMessages(messages);

      if (!this.handler) return;
      for (const waMsg of messages) {
        if (!waMsg.message || waMsg.key.fromMe) continue;
        // A reaction is an emoji pinned to another message, not an inbound turn —
        // it is mirrored into the store above, but the agent should not answer it.
        if (waMsg.message.reactionMessage) continue;

        const msg = this.normalizeMessage(waMsg);
        // Protocol/system frames (sender-key distribution, app-state sync,
        // history-sync notifications) carry no text or attachments — they are
        // mirrored above for completeness but are not an inbound turn.
        if (!msg.text && msg.attachments.length === 0) continue;
        log.info("message received", {
          from: msg.channelUserId,
          threadId: msg.threadId,
          threadType: msg.threadType,
        });

        try {
          await this.handler!(msg);
        } catch (err) {
          log.error("message handler error", {
            messageId: msg.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    // The initial history sync delivers contacts, chats, and recent messages in
    // reverse-chronological batches; the `contacts.*` / `chats.upsert` events
    // keep the mirror current afterwards. All of it flows into `syncSink`.
    this.sock.ev.on("messaging-history.set", ({ contacts, chats, messages, progress }) => {
      if (generation !== this.socketGeneration) return;
      log.info("history sync batch", {
        contacts: contacts?.length ?? 0,
        chats: chats?.length ?? 0,
        messages: messages?.length ?? 0,
        progress: progress ?? null,
      });
      this.persistContacts(contacts ?? []);
      this.persistChats(chats ?? []);
      this.persistMessages(messages ?? []);
    });

    this.sock.ev.on("contacts.upsert", (contacts) => {
      if (generation !== this.socketGeneration) return;
      this.persistContacts(contacts);
    });

    this.sock.ev.on("contacts.update", (updates) => {
      if (generation !== this.socketGeneration) return;
      this.persistContacts(updates);
    });

    this.sock.ev.on("chats.upsert", (chats) => {
      if (generation !== this.socketGeneration) return;
      this.persistChats(chats);
    });
  }

  /**
   * Seed (or refresh) our own contact so the notes-to-self chat shows a real
   * name in the People tab. WhatsApp's history sync leaves the self contact
   * nameless, and the LID-form self has no contact row at all — canonicalization
   * folds both onto the phone-number JID, which this row backs.
   */
  private seedSelfContact(): void {
    const jid = this.selfPnJid();
    const name = this.sock?.user?.name ?? undefined;
    if (!jid) return;
    this.persistContacts([{ id: jid, name, notify: name }]);
  }

  private persistContacts(contacts: Array<Partial<Contact>>): void {
    if (!this.syncSink || contacts.length === 0) return;
    const inputs = contacts
      .map(mapWaContact)
      .filter((c): c is WaContactInput => c !== null)
      .map((c) => ({ ...c, jid: this.canonicalJid(c.jid) }));
    if (inputs.length === 0) return;
    void this.syncSink.upsertContacts(inputs).catch((err) => {
      log.error("failed to persist whatsapp contacts", { error: errMsg(err) });
    });
  }

  private persistChats(chats: Chat[]): void {
    if (!this.syncSink || chats.length === 0) return;
    const inputs = chats
      .map(mapWaChat)
      .filter((c): c is WaChatInput => c !== null)
      .map((c) => ({ ...c, jid: this.canonicalJid(c.jid) }));
    if (inputs.length === 0) return;
    void this.syncSink.upsertChats(inputs).catch((err) => {
      log.error("failed to persist whatsapp chats", { error: errMsg(err) });
    });
  }

  private persistMessages(messages: WAMessage[]): void {
    if (!this.syncSink || messages.length === 0) return;
    const inputs = messages
      .map(mapWaMessage)
      .filter((m): m is WaMessageInput => m !== null)
      .map((m) => ({
        ...m,
        chatJid: this.canonicalJid(m.chatJid),
        senderJid: m.senderJid ? this.canonicalJid(m.senderJid) : null,
      }));
    if (inputs.length === 0) return;
    void this.syncSink.upsertMessages(inputs).catch((err) => {
      log.error("failed to persist whatsapp messages", { error: errMsg(err) });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socketGeneration += 1;
    this.connectionStatus = "disconnected";
    this.currentQr = null;
    this.pairingState = "idle";
    this.connectedPhoneNumber = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sock?.end(undefined);
    this.sock = null;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    const normalizedPhoneNumber = phoneNumber.replace(/\D/g, "");
    if (normalizedPhoneNumber.length < 8 || normalizedPhoneNumber.length > 15) {
      throw new Error("Invalid phone number. Use country code + digits only.");
    }

    // Keep retrying through transient reconnect churn (common in Docker startup).
    const deadline = Date.now() + 60_000;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      if (this.connectionStatus === "open") {
        throw new Error("WhatsApp is already connected");
      }
      if (this.pairingState === "registered") {
        throw new Error("This WhatsApp session is already paired; use the normal connection flow");
      }
      // Baileys' own pairing-code example waits for the first QR event before
      // calling requestPairingCode(). `start()` returns as soon as the socket is
      // constructed, so merely seeing `connecting` does not mean the
      // registration handshake is ready yet. Calling earlier can still return
      // a locally generated code, then have WhatsApp immediately close the
      // half-initialized login with 401.
      if (!this.sock || this.connectionStatus === "disconnected" || this.pairingState !== "ready") {
        await new Promise((r) => setTimeout(r, 750));
        continue;
      }

      try {
        return await this.sock.requestPairingCode(normalizedPhoneNumber);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        const msg = error.message.toLowerCase();
        // Socket can flap while Noise/auth is still settling; keep retrying.
        if (
          msg.includes("connection closed") ||
          msg.includes("timed out") ||
          msg.includes("not connected") ||
          msg.includes("stream errored")
        ) {
          await new Promise((r) => setTimeout(r, 1_000));
          continue;
        }
        throw error;
      }
    }

    if (lastError) {
      throw new Error(`Timed out requesting pairing code: ${lastError.message}`);
    }
    throw new Error("Timed out waiting for WhatsApp pairing handshake to be ready");
  }

  getConnectionState(): {
    status: WhatsAppConnectionStatus;
    qr: string | null;
    phoneNumber: string | null;
  } {
    return {
      status: this.connectionStatus,
      qr: this.currentQr,
      phoneNumber: this.connectedPhoneNumber,
    };
  }

  /** Our own phone-number address (`<pn>@s.whatsapp.net`), device stripped. */
  private selfPnJid(): string | null {
    const id = this.sock?.user?.id;
    return id ? jidNormalizedUser(id) : null;
  }

  /** Our own LID address (`<lid>@lid`), device stripped, when WhatsApp reports one. */
  private selfLidJid(): string | null {
    const lid = this.sock?.user?.lid;
    return lid ? jidNormalizedUser(lid) : null;
  }

  /**
   * Does `jid` address us? WhatsApp gives "me" two unrelated user numbers — the
   * phone-number form and the LID form — so a single `areJidsSameUser` check
   * against `user.id` misses the LID self. Check both.
   */
  private isSelfJid(jid: string): boolean {
    const pn = this.selfPnJid();
    const lid = this.selfLidJid();
    return (pn != null && areJidsSameUser(jid, pn)) || (lid != null && areJidsSameUser(jid, lid));
  }

  /**
   * Collapse a JID to the single form we key a conversation on. WhatsApp
   * addresses the same user up to three ways — bare phone (`<pn>@s.whatsapp.net`),
   * device-suffixed (`<pn>:7@s.whatsapp.net`), and LID (`<lid>@lid`) — and the
   * notes-to-self chat in particular shows up under all three. We strip the
   * `:device` suffix from every private JID (so a send never targets one linked
   * device, and echoes reconcile) and fold every form of "me" onto one canonical
   * self JID (the phone-number form, which is also the People-tab contact key) so
   * the self-chat stays unified instead of fragmenting across three threads.
   * Groups pass through untouched.
   */
  private canonicalJid(jid: string): string {
    if (!jid || isJidGroup(jid)) return jid;
    const normalized = jidNormalizedUser(jid);
    if (this.isSelfJid(normalized)) return this.selfPnJid() ?? normalized;
    return normalized;
  }

  async sendMessage(_channelUserId: string, threadId: string, message: OutgoingMessage) {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const jid = this.canonicalJid(threadId);

    try {
      let messageId: string | undefined;
      if (message.text) {
        const sent = await this.sock.sendMessage(jid, { text: message.text });
        messageId = sent?.key.id ?? undefined;
      }

      for (const att of message.attachments ?? []) {
        const media = await readFile(att.source);
        switch (att.type) {
          case "image":
            await this.sock.sendMessage(jid, {
              image: media,
              caption: att.caption,
            });
            break;
          case "video":
            await this.sock.sendMessage(jid, {
              video: media,
              caption: att.caption,
            });
            break;
          case "audio":
            await this.sock.sendMessage(jid, { audio: media, mimetype: "audio/mpeg" });
            break;
          case "document":
            await this.sock.sendMessage(jid, {
              document: media,
              mimetype: "application/octet-stream",
              fileName: att.source.split("/").pop() ?? "file",
              caption: att.caption,
            });
            break;
        }
      }

      log.info("message sent", { threadId, jid });
      return { messageId, threadId };
    } catch (err) {
      log.error("failed to send message", {
        threadId,
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async saveIncomingAttachments(message: NormalizedMessage): Promise<Attachment[]> {
    if (message.attachments.length === 0) return message.attachments;
    const raw = message.rawEvent as WAMessage | undefined;
    if (!raw?.message) return message.attachments;

    const attachment = message.attachments[0];
    if (!attachment) return message.attachments;
    if (message.attachments.length > 1) {
      log.warn("whatsapp message has additional attachments without separate media payloads", {
        messageId: message.id,
        savedAttachments: 1,
        skippedAttachments: message.attachments.length - 1,
      });
    }

    let data: Buffer;
    try {
      const stream = await downloadMediaMessage(raw, "stream", {});
      data = await readAttachmentByteStream(stream);
    } catch (err) {
      if (!isAttachmentTooLargeError(err)) throw err;
      log.warn("whatsapp attachment too large, skipping save", {
        messageId: message.id,
        bytes: err.bytes,
        type: attachment.type,
        fileName: attachment.fileName ?? null,
      });
      return message.attachments;
    }

    return saveIncomingAttachmentPayloads(message, [
      {
        attachment,
        data,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      },
    ]);
  }

  onConnected(callback: (userId: string) => void): void {
    this.connectedCallback = callback;
  }

  /**
   * Register a terminal-fault sink. The adapter owns transient reconnection
   * internally; only outcomes it cannot recover reach here — today that is
   * `loggedOut` (device unlinked). the Talker maps `loggedOut` to
   * `CredentialRejected{ session }` and any other terminal to `Disconnected`.
   */
  onFault(callback: (fault: { kind: "loggedOut" | "terminal"; cause?: unknown }) => void): void {
    this.faultCallback = callback;
  }

  /** Register the destination for synced contacts, chats, and message history. */
  onSync(sink: WhatsAppSyncSink): void {
    this.syncSink = sink;
  }

  private normalizeMessage(waMsg: WAMessage): NormalizedMessage {
    const remoteJid = waMsg.key.remoteJid!;
    const isGroup = remoteJid.endsWith("@g.us");
    const threadId = this.canonicalJid(remoteJid);
    const content = describeContent(waMsg.message);

    return {
      id: waMsg.key.id!,
      channel: "whatsapp",
      channelUserId: isGroup ? this.canonicalJid(waMsg.key.participant ?? remoteJid) : threadId,
      displayName: waMsg.pushName ?? "Unknown",
      threadId,
      threadType: isGroup ? "group" : "private",
      timestamp: new Date((waMsg.messageTimestamp as number) * 1000),
      text: content.text ?? "",
      attachments: this.extractAttachments(waMsg),
      rawEvent: waMsg,
    };
  }

  private extractAttachments(waMsg: WAMessage): Attachment[] {
    const attachments: Attachment[] = [];
    const msg = unwrapMessageContent(waMsg.message);
    if (!msg) return attachments;

    if (msg.imageMessage) {
      attachments.push({
        type: "image",
        mimeType: msg.imageMessage.mimetype ?? undefined,
        caption: msg.imageMessage.caption ?? undefined,
      });
    }

    if (msg.videoMessage) {
      attachments.push({
        type: "video",
        mimeType: msg.videoMessage.mimetype ?? undefined,
        caption: msg.videoMessage.caption ?? undefined,
      });
    }

    if (msg.audioMessage) {
      attachments.push({
        type: "audio",
        mimeType: msg.audioMessage.mimetype ?? undefined,
      });
    }

    if (msg.documentMessage) {
      attachments.push({
        type: "document",
        mimeType: msg.documentMessage.mimetype ?? undefined,
        fileName: msg.documentMessage.fileName ?? undefined,
        caption: msg.documentMessage.caption ?? undefined,
      });
    }

    if (msg.stickerMessage) {
      attachments.push({
        type: "sticker",
        mimeType: msg.stickerMessage.mimetype ?? undefined,
      });
    }

    return attachments;
  }

  private async fetchLatestWaWebVersion(): Promise<[number, number, number] | null> {
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      return null;
    }
    if (cachedWaVersion && Date.now() - cachedWaVersionAt < WA_VERSION_CACHE_TTL_MS) {
      return cachedWaVersion;
    }

    try {
      const response = await fetch(WA_SW_URL, {
        method: "GET",
        headers: WA_SW_HEADERS,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`fetch failed with ${response.status}`);
      }
      const text = await response.text();
      const match = text.match(/\\?"client_revision\\?":\s*(\d+)/);
      if (!match?.[1]) {
        throw new Error("client_revision not found");
      }
      const version: [number, number, number] = [2, 3000, Number(match[1])];
      cachedWaVersion = version;
      cachedWaVersionAt = Date.now();
      log.info("using latest wa web version", { version });
      return version;
    } catch (err) {
      log.warn("failed to fetch latest wa web version, using library default", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// WhatsApp timestamps arrive as unix seconds, either a plain number or a
// protobuf Long ({ toNumber() }). Normalize both to a number of seconds.
function toSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (
    typeof value === "object" &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber(): number }).toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Map a Baileys contact (or a partial `contacts.update`) to a store DTO. */
export function mapWaContact(c: Partial<Contact>): WaContactInput | null {
  if (!c.id) return null;
  // imgUrl is a real URL, the sentinel string 'changed', or null — only keep URLs.
  const imgUrl = typeof c.imgUrl === "string" && c.imgUrl !== "changed" ? c.imgUrl : null;
  return {
    jid: c.id,
    phoneNumber: normalizeWaPhoneIdentifier(c.phoneNumber ?? c.id),
    name: c.name ?? null,
    notify: c.notify ?? null,
    verifiedName: c.verifiedName ?? null,
    imgUrl,
  };
}

function normalizeWaPhoneIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.endsWith("@lid") || value.endsWith("@g.us")) return null;
  const user = value.replace(/@s\.whatsapp\.net$/, "").replace(/:.+$/, "");
  const digits = user.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** Map a Baileys chat to a store DTO. */
export function mapWaChat(c: Chat): WaChatInput | null {
  if (!c.id) return null;
  const lastSeconds = toSeconds(c.conversationTimestamp);
  return {
    jid: c.id,
    name: c.name ?? null,
    isGroup: c.id.endsWith("@g.us"),
    lastMessageAt: lastSeconds == null ? null : new Date(lastSeconds * 1000),
    unreadCount: typeof c.unreadCount === "number" ? c.unreadCount : null,
    archived: c.archived ?? null,
  };
}

interface MessageContentSummary {
  type: string;
  text: string | null;
  hasMedia: boolean;
  /** Reaction target message id (`type === "reaction"` only); null otherwise. */
  reactsToId: string | null;
}

type WaMessageContent = NonNullable<WAMessage["message"]>;

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length > 0) return text;
  }
  return null;
}

function labeledText(label: string, ...values: unknown[]): string {
  const text = firstText(...values);
  return text ? `${label}: ${text}` : label;
}

function summarizeLocation(label: string, location: unknown): string {
  if (!location || typeof location !== "object") return label;
  const r = location as Record<string, unknown>;
  const text = firstText(r.name, r.address, r.comment);
  if (text) return `${label}: ${text}`;
  if (typeof r.degreesLatitude === "number" && typeof r.degreesLongitude === "number") {
    return `${label}: ${r.degreesLatitude}, ${r.degreesLongitude}`;
  }
  return label;
}

function unwrapMessageContent(message: WAMessage["message"]): WaMessageContent | null {
  let current = message ?? null;
  for (let i = 0; i < 5 && current; i += 1) {
    const next =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.documentWithCaptionMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.editedMessage?.message ??
      current.groupMentionedMessage?.message ??
      current.botInvokeMessage?.message ??
      current.botTaskMessage?.message ??
      current.questionMessage?.message ??
      current.questionReplyMessage?.message ??
      current.groupStatusMentionMessage?.message ??
      current.pollCreationMessageV4?.message ??
      current.statusAddYours?.message ??
      current.groupStatusMessage?.message ??
      current.limitSharingMessage?.message ??
      current.groupStatusMessageV2?.message ??
      current.botForwardedMessage?.message;
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function contentKey(message: WaMessageContent): string | null {
  for (const key of Object.keys(message)) {
    if (key === "messageContextInfo") continue;
    const value = (message as Record<string, unknown>)[key];
    if (value != null) return key;
  }
  return null;
}

function humanizeContentKey(key: string | null): string {
  if (!key) return "unknown";
  return key
    .replace(/Message$/u, "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function isProtocolOnlyMessage(message: WaMessageContent): boolean {
  if (
    message.senderKeyDistributionMessage ||
    message.fastRatchetKeySenderKeyDistributionMessage ||
    message.messageHistoryBundle ||
    message.messageHistoryNotice ||
    message.stickerSyncRmrMessage ||
    message.encReactionMessage ||
    message.encCommentMessage ||
    message.secretEncryptedMessage
  ) {
    return true;
  }

  const protocol = message.protocolMessage;
  if (!protocol) return false;
  if (protocol.editedMessage) return false;
  const protocolType = Number(protocol.type);
  return (
    protocol.historySyncNotification != null ||
    protocol.appStateSyncKeyShare != null ||
    protocol.appStateSyncKeyRequest != null ||
    protocol.initialSecurityNotificationSettingSync != null ||
    protocol.appStateFatalExceptionNotification != null ||
    protocol.peerDataOperationRequestMessage != null ||
    protocol.peerDataOperationRequestResponseMessage != null ||
    protocol.cloudApiThreadControlNotification != null ||
    protocol.lidMigrationMappingSyncMessage != null ||
    [3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 21, 22, 28, 29].includes(protocolType)
  );
}

function describeContent(message: WAMessage["message"]): MessageContentSummary {
  const content = unwrapMessageContent(message);
  if (!content) return { type: "protocol", text: null, hasMedia: false, reactsToId: null };
  if (isProtocolOnlyMessage(content)) {
    return { type: "protocol", text: null, hasMedia: false, reactsToId: null };
  }
  // A reaction is just an emoji (`text`) pinned to another message — render it
  // attached to that message, never as a bubble of its own. An empty emoji is a
  // reaction removal, dropped upstream in mapWaMessage.
  if (content.reactionMessage) {
    return {
      type: "reaction",
      text: content.reactionMessage.text ?? null,
      hasMedia: false,
      reactsToId: content.reactionMessage.key?.id ?? null,
    };
  }
  if (content.conversation) {
    return { type: "text", text: content.conversation, hasMedia: false, reactsToId: null };
  }
  if (content.extendedTextMessage?.text) {
    return {
      type: "text",
      text: content.extendedTextMessage.text,
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.imageMessage) {
    return {
      type: "image",
      text: content.imageMessage.caption ?? null,
      hasMedia: true,
      reactsToId: null,
    };
  }
  if (content.videoMessage) {
    return {
      type: "video",
      text: content.videoMessage.caption ?? null,
      hasMedia: true,
      reactsToId: null,
    };
  }
  if (content.audioMessage) {
    return { type: "audio", text: null, hasMedia: true, reactsToId: null };
  }
  if (content.documentMessage) {
    return {
      type: "document",
      text: content.documentMessage.caption ?? content.documentMessage.fileName ?? null,
      hasMedia: true,
      reactsToId: null,
    };
  }
  if (content.stickerMessage) {
    return { type: "sticker", text: null, hasMedia: true, reactsToId: null };
  }
  if (content.ptvMessage) {
    return {
      type: "video",
      text: content.ptvMessage.caption ?? "Video message",
      hasMedia: true,
      reactsToId: null,
    };
  }
  if (content.contactMessage) {
    return {
      type: "contact",
      text: labeledText("Contact", content.contactMessage.displayName),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.contactsArrayMessage) {
    const count = content.contactsArrayMessage.contacts?.length ?? 0;
    return {
      type: "contact",
      text: labeledText(
        `${count || "Multiple"} contacts`,
        content.contactsArrayMessage.displayName,
      ),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.locationMessage) {
    return {
      type: "location",
      text: summarizeLocation("Location", content.locationMessage),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.liveLocationMessage) {
    return {
      type: "location",
      text: summarizeLocation("Live location", content.liveLocationMessage),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.groupInviteMessage) {
    return {
      type: "group_invite",
      text: labeledText(
        "Group invite",
        content.groupInviteMessage.caption,
        content.groupInviteMessage.groupName,
      ),
      hasMedia: Boolean(content.groupInviteMessage.jpegThumbnail),
      reactsToId: null,
    };
  }
  if (content.templateButtonReplyMessage) {
    return {
      type: "interactive_response",
      text: labeledText(
        "Button reply",
        content.templateButtonReplyMessage.selectedDisplayText,
        content.templateButtonReplyMessage.selectedId,
      ),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.buttonsResponseMessage) {
    return {
      type: "interactive_response",
      text: labeledText(
        "Button reply",
        content.buttonsResponseMessage.selectedDisplayText,
        content.buttonsResponseMessage.selectedButtonId,
      ),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.listResponseMessage) {
    return {
      type: "interactive_response",
      text: labeledText(
        "List reply",
        content.listResponseMessage.title,
        content.listResponseMessage.description,
        content.listResponseMessage.singleSelectReply?.selectedRowId,
      ),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (
    content.pollCreationMessage ||
    content.pollCreationMessageV2 ||
    content.pollCreationMessageV3
  ) {
    const poll =
      content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
    return {
      type: "poll",
      text: labeledText("Poll", poll?.name),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.pollUpdateMessage) {
    return { type: "poll_update", text: "Poll vote", hasMedia: false, reactsToId: null };
  }
  if (content.pollResultSnapshotMessage || content.pollResultSnapshotMessageV3) {
    const poll = content.pollResultSnapshotMessage ?? content.pollResultSnapshotMessageV3;
    return {
      type: "poll_result",
      text: labeledText("Poll result", poll?.name),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.productMessage) {
    return {
      type: "product",
      text: labeledText(
        "Product",
        content.productMessage.body,
        content.productMessage.footer,
        content.productMessage.product?.title,
        content.productMessage.product?.description,
        content.productMessage.catalog?.title,
        content.productMessage.catalog?.description,
      ),
      hasMedia: true,
      reactsToId: null,
    };
  }
  if (content.orderMessage) {
    return {
      type: "order",
      text: labeledText("Order", content.orderMessage.message, content.orderMessage.orderTitle),
      hasMedia: Boolean(content.orderMessage.thumbnail),
      reactsToId: null,
    };
  }
  if (content.invoiceMessage) {
    return {
      type: "invoice",
      text: labeledText("Invoice", content.invoiceMessage.note, content.invoiceMessage.token),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.paymentInviteMessage) {
    return { type: "payment", text: "Payment invite", hasMedia: false, reactsToId: null };
  }
  if (content.eventMessage) {
    return {
      type: "event",
      text: labeledText(
        content.eventMessage.isCanceled ? "Canceled event" : "Event",
        content.eventMessage.name,
        content.eventMessage.description,
        content.eventMessage.location?.name,
      ),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.scheduledCallCreationMessage) {
    return {
      type: "call",
      text: labeledText("Scheduled call", content.scheduledCallCreationMessage.title),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.scheduledCallEditMessage) {
    return { type: "call", text: "Scheduled call updated", hasMedia: false, reactsToId: null };
  }
  if (content.callLogMesssage || content.call || content.bcallMessage) {
    return { type: "call", text: "Call", hasMedia: false, reactsToId: null };
  }
  if (content.keepInChatMessage) {
    return { type: "chat_action", text: "Kept message in chat", hasMedia: false, reactsToId: null };
  }
  if (content.pinInChatMessage) {
    return { type: "chat_action", text: "Pinned message", hasMedia: false, reactsToId: null };
  }
  if (content.requestPhoneNumberMessage) {
    return {
      type: "phone_request",
      text: "Phone number requested",
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.protocolMessage?.editedMessage) {
    return describeContent(content.protocolMessage.editedMessage);
  }
  if (content.protocolMessage?.type === 0) {
    return { type: "message_revoked", text: "Message deleted", hasMedia: false, reactsToId: null };
  }
  if (content.protocolMessage?.type === 11) {
    return { type: "phone_share", text: "Phone number shared", hasMedia: false, reactsToId: null };
  }
  if (content.protocolMessage?.type === 23) {
    return { type: "reminder", text: "Reminder", hasMedia: false, reactsToId: null };
  }
  if (content.newsletterAdminInviteMessage) {
    return {
      type: "newsletter_invite",
      text: labeledText(
        "Newsletter invite",
        content.newsletterAdminInviteMessage.caption,
        content.newsletterAdminInviteMessage.newsletterName,
      ),
      hasMedia: Boolean(content.newsletterAdminInviteMessage.jpegThumbnail),
      reactsToId: null,
    };
  }
  if (content.newsletterFollowerInviteMessageV2) {
    return {
      type: "newsletter_invite",
      text: labeledText(
        "Newsletter invite",
        content.newsletterFollowerInviteMessageV2.caption,
        content.newsletterFollowerInviteMessageV2.newsletterName,
      ),
      hasMedia: Boolean(content.newsletterFollowerInviteMessageV2.jpegThumbnail),
      reactsToId: null,
    };
  }
  if (content.questionResponseMessage) {
    return {
      type: "question_response",
      text: labeledText("Question response", content.questionResponseMessage.text),
      hasMedia: false,
      reactsToId: null,
    };
  }
  if (content.statusQuestionAnswerMessage) {
    return {
      type: "question_response",
      text: labeledText("Status answer", content.statusQuestionAnswerMessage.text),
      hasMedia: false,
      reactsToId: null,
    };
  }

  const key = contentKey(content);
  return {
    type: "unsupported",
    text: `Unsupported WhatsApp ${humanizeContentKey(key)} message`,
    hasMedia: false,
    reactsToId: null,
  };
}

/**
 * Map a Baileys message to a store DTO. Returns null for stubs without a key,
 * remote JID, timestamp, or renderable content (e.g. protocol/receipt frames).
 */
export function mapWaMessage(m: WAMessage): WaMessageInput | null {
  const id = m.key?.id;
  const chatJid = m.key?.remoteJid;
  if (!id || !chatJid || !m.message) return null;
  const seconds = toSeconds(m.messageTimestamp);
  if (seconds == null) return null;
  const { type, text, hasMedia, reactsToId } = describeContent(m.message);
  // A reaction with no emoji is a removal — nothing to render or attach.
  if (type === "reaction" && !text) return null;
  // Contentless protocol/system frames — sender-key distribution, app-state
  // sync, history-sync notifications, peer-data ops — are not part of the
  // visible conversation. Unknown-but-visible payloads intentionally fall back
  // to an "unsupported" summary instead of disappearing.
  if (type === "protocol") return null;
  return {
    id,
    chatJid,
    senderJid: m.key.participant ?? (m.key.fromMe ? null : chatJid),
    fromMe: Boolean(m.key.fromMe),
    timestamp: new Date(seconds * 1000),
    type,
    text,
    hasMedia,
    pushName: m.pushName ?? null,
    reactsToId,
  };
}

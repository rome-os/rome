// Dashboard live-events WebSocket at `/ws/events`. One socket per dashboard tab
// carries the chat status, chat session, and app catalog streams, so they hold
// none of the browser's six HTTP/1.1 connections per origin.
// The SSE routes emit the same events for clients that cannot open the socket.
// Upgrades skip the edge probe like `/ws/terminal`:
// docs/architecture/access-control.md. Reach mirrors the SSE routes: the
// guardian gets every topic, and a visitor on the dashboard allow-list gets
// every topic but `apps.catalog`. `concierge.tasks` carries the caller's own
// Concierge rows, and another owner's Concierge or task chat is not found.
//
// The wire contract lives in @rome/api-types/live-events. `subscribed` precedes
// the snapshot `chat.status` replays too. The guardian's phone app marks its
// socket with a header and holds `chat.watch:<id>` for the chat on its screen;
// that chat counts as watched (`PhoneWatching`), which holds back the
// Concierge's push there. Its data subscriptions never count.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  APP_CATALOG_TOPIC,
  CHAT_SESSION_TOPIC_PREFIX,
  CHAT_STATUS_TOPIC,
  CHAT_WATCH_TOPIC_PREFIX,
  CONCIERGE_TASKS_TOPIC,
  LIVE_EVENTS_CLIENT_HEADER,
  liveEventsClientMessageSchema,
  PHONE_CLIENT,
  type LiveEventsServerMessage,
} from "@rome/api-types/live-events";
import type { DrizzleDb } from "./db/index.js";
import type { DashboardAccessState } from "./access/dashboard-access-state.js";
import type { LiveEventEmit } from "./lib/live-event.js";
import type { PhoneWatching } from "./lib/phone-watching.js";
import { gateUpgrade, type UpgradeCaller } from "./access/ws-guardian-gate.js";
import { rejectUpgrade } from "./lib/ws-upgrade.js";
import { createLogger } from "./logger.js";

const log = createLogger("live-events-server");

const LIVE_EVENTS_PATH = "/ws/events";

type Unsubscribe = () => void;

/** The event sources behind each topic. Subscribing replays any snapshot synchronously. */
export interface LiveEventSources {
  subscribeChatStatus(emit: LiveEventEmit): Unsubscribe;
  /** Resolves false when the id names no stored webchat session, or one private to another owner. */
  hasChatSession(sessionId: string, owner: string): Promise<boolean>;
  subscribeChatSession(sessionId: string, emit: LiveEventEmit): Unsubscribe;
  subscribeAppCatalog(emit: LiveEventEmit): Unsubscribe;
  /** Emits `task_upsert` for every write to one owner's Concierge todo list. */
  subscribeConciergeTasks(owner: string, emit: LiveEventEmit): Unsubscribe;
}

export const MAX_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_PAYLOAD_BYTES = 4 * 1024;
const PING_INTERVAL_MS = 25_000;
// A tab that stops reading would otherwise grow this buffer without bound. The
// client resyncs on reconnect, so closing it loses nothing.
const MAX_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_TRY_AGAIN_LATER = 1013;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Topic =
  | { kind: "chat.status" }
  | { kind: "apps.catalog" }
  | { kind: "concierge.tasks" }
  | { kind: "chat.session"; sessionId: string }
  | { kind: "chat.watch"; sessionId: string };

function parseTopic(topic: string): Topic | null {
  if (topic === CHAT_STATUS_TOPIC) return { kind: "chat.status" };
  if (topic === APP_CATALOG_TOPIC) return { kind: "apps.catalog" };
  if (topic === CONCIERGE_TASKS_TOPIC) return { kind: "concierge.tasks" };
  if (topic.startsWith(CHAT_SESSION_TOPIC_PREFIX)) {
    const sessionId = topic.slice(CHAT_SESSION_TOPIC_PREFIX.length);
    if (SESSION_ID_PATTERN.test(sessionId)) return { kind: "chat.session", sessionId };
  }
  if (topic.startsWith(CHAT_WATCH_TOPIC_PREFIX)) {
    const sessionId = topic.slice(CHAT_WATCH_TOPIC_PREFIX.length);
    if (SESSION_ID_PATTERN.test(sessionId)) return { kind: "chat.watch", sessionId };
  }
  return null;
}

/** Whether the socket is the phone app's, by the header it sends. */
function isPhone(req: IncomingMessage): boolean {
  return req.headers[LIVE_EVENTS_CLIENT_HEADER] === PHONE_CLIENT;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function attachLiveEventsServer(
  httpServer: Server,
  db: DrizzleDb,
  dashboardAccess: Pick<DashboardAccessState, "isCloudEmailAllowed">,
  sources: LiveEventSources,
  phoneWatching?: PhoneWatching,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== LIVE_EVENTS_PATH) return;

    socket.on("error", () => socket.destroy());

    void gateUpgrade(req, socket, db, dashboardAccess)
      .then((caller) => {
        if (!caller || socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, caller, isPhone(req)));
      })
      .catch((err) => {
        log.error("live events upgrade failed", { error: errorMessage(err) });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
  };
  httpServer.on("upgrade", onUpgrade);

  function serve(ws: WebSocket, caller: UpgradeCaller, phone: boolean): void {
    // An entry exists from the subscribe message on. `unsubscribe` stays null
    // while the topic check is pending, and the identity check after it drops
    // a result whose topic was unsubscribed (or resubscribed) meanwhile.
    const subscriptions = new Map<string, { unsubscribe: Unsubscribe | null }>();
    let closed = false;
    let alive = true;

    const send = (message: LiveEventsServerMessage) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(CLOSE_TRY_AGAIN_LATER, "Client is not reading");
        return;
      }
      ws.send(JSON.stringify(message));
    };
    const sendError = (message: string, topic?: string) => send({ type: "error", topic, message });

    // A visitor dropped from the allow-list loses new subscriptions at once and
    // the socket at the next ping, as the edge probe would refuse a new stream.
    const visitorAllowed = () =>
      caller.kind === "guardian" || dashboardAccess.isCloudEmailAllowed(caller.email);
    // App existence and change timing stay guardian-only, as on `/api/apps/events`.
    const permitted = (topic: Topic) =>
      caller.kind === "guardian" || (topic.kind !== "apps.catalog" && visitorAllowed());
    // Whose Concierge todo list and private chats this socket may read.
    const owner = caller.kind === "guardian" ? "guardian" : `visitor:${caller.accountId}`;
    const exists = async (topic: Topic): Promise<boolean> =>
      topic.kind === "chat.session" || topic.kind === "chat.watch"
        ? sources.hasChatSession(topic.sessionId, owner)
        : true;

    const open = (topic: Topic, emit: LiveEventEmit): Unsubscribe => {
      switch (topic.kind) {
        case "chat.status":
          return sources.subscribeChatStatus(emit);
        case "apps.catalog":
          return sources.subscribeAppCatalog(emit);
        case "concierge.tasks":
          return sources.subscribeConciergeTasks(owner, emit);
        case "chat.session":
          return sources.subscribeChatSession(topic.sessionId, emit);
        case "chat.watch":
          // The chat on the guardian's phone: what the Concierge says there is
          // read on the phone, so it is not pushed to it. Anyone else's watch
          // is held and counts for nothing.
          if (!phone || caller.kind !== "guardian" || !phoneWatching) return () => {};
          return phoneWatching.watch(topic.sessionId);
      }
    };

    const subscribe = (name: string) => {
      if (subscriptions.has(name)) return;
      const topic = parseTopic(name);
      if (topic?.kind === "chat.watch") {
        // A phone shows one chat, so its watch sits outside the cap: a new
        // watch replaces the one before, and the cap never refuses it.
        const held = [...subscriptions.keys()].find((key) =>
          key.startsWith(CHAT_WATCH_TOPIC_PREFIX),
        );
        if (held) unsubscribe(held);
      } else if (dataSubscriptions() >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
        sendError("Too many subscriptions", name);
        return;
      }
      if (!topic) {
        sendError("Unknown topic", name);
        return;
      }
      if (!permitted(topic)) {
        sendError("Forbidden", name);
        return;
      }
      const entry: { unsubscribe: Unsubscribe | null } = { unsubscribe: null };
      subscriptions.set(name, entry);
      exists(topic)
        .then((found) => {
          if (closed || subscriptions.get(name) !== entry) return;
          if (!found) {
            subscriptions.delete(name);
            sendError("Not found", name);
            return;
          }
          send({ type: "subscribed", topic: name });
          entry.unsubscribe = open(topic, (event, data) =>
            send({ type: "event", topic: name, event, data }),
          );
        })
        .catch((err) => {
          log.error("live events subscribe failed", { topic: name, error: errorMessage(err) });
          if (closed || subscriptions.get(name) !== entry) return;
          subscriptions.delete(name);
          sendError("Subscribe failed", name);
        });
    };

    const dataSubscriptions = () =>
      [...subscriptions.keys()].filter((key) => !key.startsWith(CHAT_WATCH_TOPIC_PREFIX)).length;

    const unsubscribe = (name: string) => {
      const entry = subscriptions.get(name);
      if (!entry) return;
      subscriptions.delete(name);
      entry.unsubscribe?.();
    };

    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      for (const entry of subscriptions.values()) entry.unsubscribe?.();
      subscriptions.clear();
    };

    const ping = setInterval(() => {
      if (!visitorAllowed()) {
        ws.close(CLOSE_POLICY_VIOLATION, "Forbidden");
        return;
      }
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_INTERVAL_MS);
    ws.on("pong", () => {
      alive = true;
    });

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      let parsed: unknown;
      try {
        parsed = isBinary ? undefined : JSON.parse(raw.toString());
      } catch {
        parsed = undefined;
      }
      const result = liveEventsClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        sendError("Invalid message");
        return;
      }
      if (result.data.type === "subscribe") subscribe(result.data.topic);
      else unsubscribe(result.data.topic);
    });
    ws.on("close", teardown);
    ws.on("error", (err) => {
      log.warn("live events socket error", { error: err.message });
      teardown();
    });
  }

  return {
    close() {
      httpServer.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

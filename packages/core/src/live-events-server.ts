// Guardian live-events WebSocket at `/ws/events`. One socket per dashboard tab
// carries the chat status, chat session, and app catalog streams, so they hold
// none of the browser's six HTTP/1.1 connections per origin (rome-os/rome#146).
// The SSE routes emit the same events for clients that cannot open the socket.
// Upgrades skip the edge probe like `/ws/terminal`:
// docs/architecture/access-control.md.
//
// Protocol, JSON text frames:
//   client → server  {type:"subscribe", topic}  {type:"unsubscribe", topic}
//   server → client  {type:"subscribed", topic}  {type:"event", topic, event, data}
//                    {type:"error", topic?, message}
// `subscribed` precedes every event of that subscription, including the
// snapshot `chat.status` replays. Subscribing to a topic the socket already
// holds is a no-op. An `error` with a topic means that subscription is gone.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { DrizzleDb } from "./db/index.js";
import { gateGuardianUpgrade } from "./lib/ws-guardian-gate.js";
import { rejectUpgrade } from "./lib/ws-upgrade.js";
import { createLogger } from "./logger.js";

const log = createLogger("live-events-server");

const LIVE_EVENTS_PATH = "/ws/events";

/** Pushes one event to a subscriber. `data` is the JSON payload the SSE route writes. */
export type LiveEventEmit = (event: string, data: unknown) => void;
type Unsubscribe = () => void;

/** The event sources behind each topic. Subscribing replays any snapshot synchronously. */
export interface LiveEventSources {
  subscribeChatStatus(emit: LiveEventEmit): Unsubscribe;
  /** Resolves false when the id names no stored webchat session. */
  hasChatSession(sessionId: string): Promise<boolean>;
  subscribeChatSession(sessionId: string, emit: LiveEventEmit): Unsubscribe;
  subscribeAppCatalog(emit: LiveEventEmit): Unsubscribe;
}

export const MAX_SUBSCRIPTIONS_PER_SOCKET = 32;
const MAX_PAYLOAD_BYTES = 4 * 1024;
const PING_INTERVAL_MS = 25_000;
// A tab that stops reading would otherwise grow this buffer without bound. The
// client resyncs on reconnect, so closing it loses nothing.
const MAX_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_TRY_AGAIN_LATER = 1013;

const SESSION_TOPIC_PREFIX = "chat.session:";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Topic =
  | { kind: "chat.status" }
  | { kind: "apps.catalog" }
  | { kind: "chat.session"; sessionId: string };

const clientMessageSchema = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  topic: z.string().max(256),
});

function parseTopic(topic: string): Topic | null {
  if (topic === "chat.status") return { kind: "chat.status" };
  if (topic === "apps.catalog") return { kind: "apps.catalog" };
  if (topic.startsWith(SESSION_TOPIC_PREFIX)) {
    const sessionId = topic.slice(SESSION_TOPIC_PREFIX.length);
    if (SESSION_ID_PATTERN.test(sessionId)) return { kind: "chat.session", sessionId };
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function attachLiveEventsServer(
  httpServer: Server,
  db: DrizzleDb,
  sources: LiveEventSources,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== LIVE_EVENTS_PATH) return;

    socket.on("error", () => socket.destroy());

    void gateGuardianUpgrade(req, socket, db)
      .then((allowed) => {
        if (!allowed || socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
      })
      .catch((err) => {
        log.error("live events upgrade failed", { error: errorMessage(err) });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
  };
  httpServer.on("upgrade", onUpgrade);

  function serve(ws: WebSocket): void {
    // An entry exists from the subscribe message on. `unsubscribe` stays null
    // while the topic check is pending, and the identity check after it drops
    // a result whose topic was unsubscribed (or resubscribed) meanwhile.
    const subscriptions = new Map<string, { unsubscribe: Unsubscribe | null }>();
    let closed = false;
    let alive = true;

    const send = (message: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(CLOSE_TRY_AGAIN_LATER, "Client is not reading");
        return;
      }
      ws.send(JSON.stringify(message));
    };
    const sendError = (message: string, topic?: string) => send({ type: "error", topic, message });

    const authorize = async (topic: Topic): Promise<boolean> =>
      topic.kind === "chat.session" ? sources.hasChatSession(topic.sessionId) : true;

    const open = (topic: Topic, emit: LiveEventEmit): Unsubscribe => {
      switch (topic.kind) {
        case "chat.status":
          return sources.subscribeChatStatus(emit);
        case "apps.catalog":
          return sources.subscribeAppCatalog(emit);
        case "chat.session":
          return sources.subscribeChatSession(topic.sessionId, emit);
      }
    };

    const subscribe = (name: string) => {
      if (subscriptions.has(name)) return;
      if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
        sendError("Too many subscriptions", name);
        return;
      }
      const topic = parseTopic(name);
      if (!topic) {
        sendError("Unknown topic", name);
        return;
      }
      const entry: { unsubscribe: Unsubscribe | null } = { unsubscribe: null };
      subscriptions.set(name, entry);
      authorize(topic)
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
      const result = clientMessageSchema.safeParse(parsed);
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

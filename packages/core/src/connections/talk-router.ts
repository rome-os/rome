import type { ConversationId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import type { InboundMessage, TalkFeatureMap, TalkFeatureName, TalkRouter } from "./types.js";
import type { Connection, ConnectionId } from "./types.js";
import type { ConnectionRegistry } from "./registry.js";
import { createLogger } from "../logger.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";

const log = createLogger("talk-router");

/** Decides whether a subscriber may hear an inbound message (pairing). */
type Admission = (
  connectionId: string,
  service: string,
  message: InboundMessage,
  router: TalkRouter,
) => Promise<boolean>;

/** How long one admission may hold its conversation. Pairing admission is a
 *  few database reads, so fifteen seconds means the database is stuck. */
export const ADMISSION_TIMEOUT_MS = 15_000;

export class ConnectionTalkRouter implements TalkRouter {
  private readonly handlers = new Map<
    ConnectionId,
    Set<(message: InboundMessage) => Promise<void>>
  >();

  private readonly attached = new Map<ConnectionId, () => void>();

  /** Admits one message at a time per connection and conversation. */
  private readonly admissions = new KeyedMutex();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly admit?: Admission,
    private readonly options: { admissionTimeoutMs?: number } = {},
  ) {
    registry.onUnlocked("talk", (connection) => this.attach(connection));
  }

  async list(): Promise<Array<{ connectionId: string; service: string }>> {
    return this.registry
      .all()
      .filter((connection) => connection.status().talk.state !== "unsupported")
      .map((connection) => ({ connectionId: connection.id, service: connection.service }));
  }

  subscribe(connectionId: string, handler: (message: InboundMessage) => Promise<void>): () => void {
    const handlers = this.handlers.get(connectionId) ?? new Set();
    handlers.add(handler);
    this.handlers.set(connectionId, handlers);
    this.attach(this.registry.get(connectionId));
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(connectionId);
    };
  }

  async send(
    connectionId: string,
    conversationId: ConversationId,
    message: OutgoingMessage,
  ): Promise<MessageReceipt> {
    const talk = this.requireTalk(connectionId);
    return talk.send(conversationId, message);
  }

  feature<K extends TalkFeatureName>(connectionId: string, name: K): TalkFeatureMap[K] | null {
    const current = this.registry.get(connectionId).talk?.feature(name);
    if (!current) {
      log.debug("talk_feature.unavailable", { connectionId, feature: name });
      return null;
    }
    return new Proxy({} as TalkFeatureMap[K] & object, {
      get: (_target, property) => {
        return (...args: unknown[]) => {
          const feature = this.requireTalk(connectionId).feature(name) as
            | (TalkFeatureMap[K] & Record<PropertyKey, unknown>)
            | null;
          if (!feature) {
            log.warn("talk_feature.unavailable", { connectionId, feature: name });
            throw new Error(`talk feature "${name}" is unavailable`);
          }
          const method = feature[property];
          if (typeof method !== "function") {
            throw new Error(`talk feature "${name}" has no operation "${String(property)}"`);
          }
          return method.apply(feature, args);
        };
      },
    });
  }

  connectionForService(service: string): Connection | null {
    return this.registry.find(service)[0] ?? null;
  }

  private attach(connection: Connection): void {
    const talk = connection.talk;
    if (!talk) return;
    const previous = this.attached.get(connection.id);
    previous?.();
    const detach = talk.subscribe(async (message) => {
      if (!this.admit) {
        await this.startHandlers(connection.id, message);
        return;
      }
      const started = await this.admitInOrder(connection, message, this.admit);
      if (started) await started.handled;
    });
    this.attached.set(connection.id, detach);
  }

  /** Admission awaits the database, and pooled queries can finish in either
   *  order. Each message's admission waits for the previous one in its
   *  conversation, and an admitted message's handlers start before the next
   *  admission begins, so handlers hear a conversation in arrival order.
   *  An admission therefore holds up its conversation's next message for as
   *  long as it runs; pairing admission waits only on its reads and sends its
   *  replies in the background. An admission that runs past the timeout fails
   *  closed: the message is not admitted, and the next one proceeds in order.
   *  The handlers' completion is returned inside an object so the conversation
   *  is released once they start, not once they finish. */
  private admitInOrder(
    connection: Connection,
    message: InboundMessage,
    admit: Admission,
  ): Promise<{ handled: Promise<unknown> } | null> {
    const key = `${connection.id}\0${message.conversationId}`;
    return this.admissions.runExclusive(key, async () => {
      if (!(await this.admitWithin(connection, message, admit))) return null;
      return { handled: this.startHandlers(connection.id, message) };
    });
  }

  private async admitWithin(
    connection: Connection,
    message: InboundMessage,
    admit: Admission,
  ): Promise<boolean> {
    const timeoutMs = this.options.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        log.warn("admission timed out; message not admitted", {
          connectionId: connection.id,
          conversationId: message.conversationId,
          messageId: message.messageId,
          timeoutMs,
        });
        resolve(false);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        admit(connection.id, connection.service, message, this),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private startHandlers(connectionId: ConnectionId, message: InboundMessage): Promise<unknown> {
    return Promise.all(
      [...(this.handlers.get(connectionId) ?? [])].map((handler) => handler(message)),
    );
  }

  private requireTalk(connectionId: string) {
    const connection = this.registry.get(connectionId);
    const talk = connection.talk;
    if (!talk) throw new Error(`Talk is unavailable for connection "${connectionId}"`);
    return talk;
  }
}

export function createTalkRouter(
  registry: ConnectionRegistry,
  admit?: ConstructorParameters<typeof ConnectionTalkRouter>[1],
  options?: ConstructorParameters<typeof ConnectionTalkRouter>[2],
): ConnectionTalkRouter {
  return new ConnectionTalkRouter(registry, admit, options);
}

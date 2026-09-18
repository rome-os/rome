import type {
  ConversationId,
  InboundMessage,
  MessageReceipt,
  OutgoingMessage,
  TalkFeatureMap,
  TalkFeatureName,
  TalkRouter,
} from "@rome-os/app-runtime";
import type { Connection, ConnectionId } from "./types.js";
import type { ConnectionRegistry } from "./registry.js";
import { createLogger } from "../logger.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { DeliveryScheduler } from "./delivery/scheduler.js";
import { physicalDeliveryScope } from "./delivery/physical-operation.js";
import { resolveDeliveryProfile } from "./delivery/profile.js";
import type { DeliveryProfile } from "./delivery/profile.js";
import { type DeliveryRepository, type DeliveryTarget } from "./delivery/transport.js";
import { RunDelivery } from "./delivery/run-delivery.js";

const log = createLogger("talk-router");

export class ConnectionTalkRouter implements TalkRouter {
  private readonly deliveryScheduler = new DeliveryScheduler();
  private readonly sends = new KeyedMutex();
  private readonly runDeliveries = new Map<string, RunDelivery>();
  private readonly creatingDeliveries = new Map<string, Promise<RunDelivery | null>>();
  private readonly handlers = new Map<
    ConnectionId,
    Set<(message: InboundMessage) => Promise<void>>
  >();

  private readonly attached = new Map<ConnectionId, () => void>();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly admit?: (
      connectionId: string,
      service: string,
      message: InboundMessage,
      router: TalkRouter,
    ) => Promise<boolean>,
    private readonly deliverySettings?: { get(key: string): Promise<unknown> },
    private readonly deliveryRepository?: DeliveryRepository,
    private readonly deliveryDefaults: Partial<DeliveryProfile> = {},
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
    const signal = message.turnId ? this.runDeliveries.get(message.turnId)?.signal : undefined;
    return this.sends.runExclusive(`${connectionId}\0${conversationId}`, async () => {
      signal?.throwIfAborted();
      const feature = talk.feature("textDelivery");
      if (!feature) return talk.send(conversationId, message);
      const described = await feature.describe();
      const profile = resolveDeliveryProfile(
        described.profile,
        await this.deliverySettings?.get(`connection_delivery:${connectionId}`),
        described.supportsUpdate,
        this.deliveryDefaults,
      );
      return physicalDeliveryScope.run(
        {
          profile,
          scheduler: this.deliveryScheduler,
          signal,
          assertAuthorized: () => {
            talk.feature("textDelivery");
          },
        },
        () => talk.send(conversationId, message),
      );
    });
  }

  async createRunDelivery(
    connectionId: string,
    runId: string,
    target: DeliveryTarget,
  ): Promise<RunDelivery | null> {
    const existing = this.runDeliveries.get(runId);
    if (existing) return existing;
    const pending = this.creatingDeliveries.get(runId);
    if (pending) return pending;
    const creation = this.prepareRunDelivery(connectionId, runId, target);
    this.creatingDeliveries.set(runId, creation);
    try {
      return await creation;
    } finally {
      this.creatingDeliveries.delete(runId);
    }
  }

  private async prepareRunDelivery(
    connectionId: string,
    runId: string,
    target: DeliveryTarget,
  ): Promise<RunDelivery | null> {
    const talk = this.requireTalk(connectionId);
    const feature = talk.feature("textDelivery");
    if (!feature || !this.deliveryRepository) return null;
    const described = await feature.describe();
    const profile = resolveDeliveryProfile(
      described.profile,
      await this.deliverySettings?.get(`connection_delivery:${connectionId}`),
      described.supportsUpdate,
      this.deliveryDefaults,
    );
    const delivery = new RunDelivery(
      runId,
      target,
      {
        profile,
        codec: {
          render: (source, settled) => feature.render({ source, settled }),
          length: (text) => feature.measure({ text }),
        },
        assertAuthorized: () => {
          talk.feature("textDelivery");
        },
        create: (destination, text) => feature.create({ ...destination, text }),
        ...(described.supportsUpdate
          ? { update: (receipt: MessageReceipt, text: string) => feature.update({ receipt, text }) }
          : {}),
      },
      this.deliveryScheduler,
      this.deliveryRepository,
      (error) =>
        log.error("delivery evidence write failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    this.runDeliveries.set(runId, delivery);
    if (this.runDeliveries.size > 256) {
      for (const [id, run] of this.runDeliveries) {
        if (id !== runId && run.terminal) this.runDeliveries.delete(id);
        if (this.runDeliveries.size <= 256) break;
      }
    }
    return delivery;
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
      if (this.admit && !(await this.admit(connection.id, connection.service, message, this)))
        return;
      await Promise.all(
        [...(this.handlers.get(connection.id) ?? [])].map((handler) => handler(message)),
      );
    });
    this.attached.set(connection.id, detach);
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
  deliverySettings?: { get(key: string): Promise<unknown> },
  deliveryRepository?: DeliveryRepository,
  deliveryDefaults?: Partial<DeliveryProfile>,
): ConnectionTalkRouter {
  return new ConnectionTalkRouter(
    registry,
    admit,
    deliverySettings,
    deliveryRepository,
    deliveryDefaults,
  );
}

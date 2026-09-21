// Worker-side typed proxies for main-process services.
//
// An action worker is a forked subprocess that holds no live reference to the
// main-process singletons (RoutineEngine, EventBus, EventCatalog, AppManager) —
// those own in-memory state (trigger timers, subscriber sets, child-process
// handles) that cannot be duplicated across processes. Each proxy below
// presents the action-facing surface of one service but forwards every call to
// the main process over the WorkerRPC IPC channel (see `getWorkerRpc`), where
// the real service does the work.
//
// They are one half of a pair: in the main process an action receives the real
// service; in a worker it receives the matching `*Proxy`. The naming mirrors
// the original (`FooEngine` -> `FooEngineProxy`) so the pair is obvious at a
// callsite. Each proxy owns the RPC method string (and timeout) for its calls,
// keeping that stringly-typed seam in one typed place instead of scattered
// across action bodies.

import {
  getWorkerRpc,
  WorkerRpcDisconnectError,
  WorkerRpcSendError,
  WorkerRpcTimeoutError,
} from "./worker-rpc-client.js";
import type { NotifyContent, NotifyService, SendOutcome } from "../lib/notify-client.js";
import type {
  AppStoreGetParams,
  AppStoreListingDetailBody,
  AppStoreListParams,
  AppStoreListingsBody,
  AppStoreReader,
  AppStoreServiceResult,
} from "../apps/store-service.js";
import type { EmailInboundControl, EmailInboundResult } from "../channels/email-control.js";
import type { SystemUpgradeChecker, SystemUpgradeOfferResult } from "../system-upgrade/service.js";
import type {
  AppLifecycle,
  AppLifecycleCreateParams,
  BackendTurnParams,
  BackendTurnRunner,
  ConversationId,
  ConversationRef,
  ConversationSettingsControl,
  ConversationSettingsPage,
  ConversationSettingsSnapshot,
  EventCatalogEntry,
  EventCatalogReader,
  EventPublisher,
  Routine,
  RoutineEngine,
  TalkFeatureMap,
  TalkFeatureName,
  TalkRouter,
  InboundMessage,
  MessageReceipt,
  OriginCaptureOutcome,
  OriginMessenger,
  OriginSendOutcome,
  OutgoingMessage,
  ListConversationSettingsInput,
  ResetConversationSettingsInput,
  UpdateConversationSettingsInput,
} from "@rome-os/app-runtime";
import { actionExecutionContext } from "./context.js";

/** apps.* operations install/pack on the main process — minutes, not seconds. */
const APP_INSTALL_RPC_TIMEOUT_MS = 3 * 60 * 1000;
/** A flag flip with no filesystem work. */
const SHORT_RPC_TIMEOUT_MS = 30 * 1000;
/** A backend turn runs a full agent turn in the main process and blocks until
 * delivery finishes, so allow long-running continuations generous headroom. */
const BACKEND_TURN_RPC_TIMEOUT_MS = 30 * 60 * 1000;
/** Push notify: NotifyClient bounds the main-to-Rome Cloud request at 120s,
 * including Rome Cloud's server-side APNs fan-out (~100s worst case). Keep this
 * RPC timeout above that HTTP budget; 150s provides 30s headroom and overrides
 * WorkerRpcClient's 30s default. */
const NOTIFY_RPC_TIMEOUT_MS = 150 * 1000;
const ORIGIN_SEND_RPC_TIMEOUT_MS = 150 * 1000;

/** App-bound exact-origin capability. Raw routes come only from Core's ALS. */
export class OriginMessengerProxy implements OriginMessenger {
  constructor(private readonly appId: string) {}

  async capture(): Promise<OriginCaptureOutcome> {
    const route = actionExecutionContext.getStore()?.originRoute;
    if (!route) {
      return { status: "unavailable", reason: "not_inbound_talk_context" };
    }
    try {
      return await getWorkerRpc().call<OriginCaptureOutcome>(
        "origin.capture",
        { appId: this.appId, route },
        { timeoutMs: SHORT_RPC_TIMEOUT_MS },
      );
    } catch {
      return { status: "unavailable", reason: "route_unavailable" };
    }
  }

  async send(input: Parameters<OriginMessenger["send"]>[0]): Promise<OriginSendOutcome> {
    try {
      return await getWorkerRpc().call<OriginSendOutcome>(
        "origin.send",
        { appId: this.appId, input },
        { timeoutMs: ORIGIN_SEND_RPC_TIMEOUT_MS },
      );
    } catch {
      // Once a send crosses the process seam, any failure is observationally
      // uncertain to the app. Never throw or automatically retry it.
      return { status: "indeterminate", deduplicated: false };
    }
  }
}

/**
 * Worker-side stand-in for the main-process `RoutineEngine`. Implements the
 * `RoutineEngine` surface an action depends on, so the same `deps.routineEngine`
 * works whether the action runs in the main process (real engine) or a worker
 * (this proxy).
 */
export class RoutineEngineProxy implements RoutineEngine {
  /** Bring a persisted routine live. The main process re-reads the row by id
   * and activates it, so only the id needs to cross the wire. */
  async activate(routine: Routine): Promise<void> {
    await getWorkerRpc().call("routines.schedule", { routineId: routine.id });
  }

  /** Tear down a routine's triggers in the main process. */
  async deactivate(routineId: string): Promise<void> {
    await getWorkerRpc().call("routines.cancel", { routineId });
  }
}

/**
 * Worker-side action existence checker backed by the main process's eager
 * ActionRegistry. The worker registry may contain lazy stubs whose modules have
 * not loaded yet, so validation paths should not treat local stub presence as
 * executable truth.
 */
export class ActionRegistryProxy {
  async has(actionName: string): Promise<boolean> {
    const result = await getWorkerRpc().call<{ hasAction: boolean }>("actions.has", { actionName });
    return result.hasAction;
  }
}

/**
 * Worker-side stand-in for the main-process `EventBus`. Publishing a domain
 * event also declares its type to the event catalog — both happen in
 * the main process's `events.publish` handler.
 */
export class EventBusProxy implements EventPublisher {
  async publish(event: {
    name: string;
    source: string;
    payload?: Record<string, unknown>;
  }): Promise<{ accepted: true }> {
    // No `?? {}` here: the `events.publish` Zod schema defaults a missing
    // payload to `{}` at the (validated) wire boundary, so defaulting again on
    // the way in is redundant.
    return await getWorkerRpc().call<{ accepted: true }>("events.publish", {
      name: event.name,
      source: event.source,
      payload: event.payload,
    });
  }
}

/** Worker-side stand-in for the main-process `EventCatalog` (read side). */
export class EventCatalogProxy implements EventCatalogReader {
  /** Find emittable event types matching `query`, best matches first, capped at
   * `limit`. `total` is the full match count before truncation. */
  async search(
    query: string,
    limit: number,
  ): Promise<{ entries: EventCatalogEntry[]; total: number }> {
    return await getWorkerRpc().call<{ entries: EventCatalogEntry[]; total: number }>(
      "events.searchCatalog",
      { query, limit },
    );
  }
}

/**
 * Worker-side stand-in for the main-process app lifecycle authority. Each method
 * owns its RPC method string and timeout. Results are app-local shapes the
 * action knows, so they return as `unknown` and the caller narrows them —
 * keeping those result types out of this SDK.
 */
export class AppManagerProxy implements AppLifecycle {
  async create(params: AppLifecycleCreateParams): Promise<unknown> {
    return await getWorkerRpc().call("apps.create", params, {
      timeoutMs: APP_INSTALL_RPC_TIMEOUT_MS,
    });
  }

  async install(params: { source: unknown; enabled?: boolean }): Promise<unknown> {
    return await getWorkerRpc().call("apps.install", params, {
      timeoutMs: APP_INSTALL_RPC_TIMEOUT_MS,
    });
  }

  async uninstall(params: { appId: string; purge?: boolean }): Promise<unknown> {
    return await getWorkerRpc().call("apps.uninstall", params, {
      timeoutMs: APP_INSTALL_RPC_TIMEOUT_MS,
    });
  }

  async setEnabled(params: { appId: string; enabled: boolean }): Promise<unknown> {
    return await getWorkerRpc().call("apps.setEnabled", params, {
      timeoutMs: SHORT_RPC_TIMEOUT_MS,
    });
  }
}

/** Worker-side stand-in for the main-process Rome App Store read surface. */
export class AppStoreProxy implements AppStoreReader {
  async listListings(
    params: AppStoreListParams = {},
  ): Promise<AppStoreServiceResult<AppStoreListingsBody>> {
    return await getWorkerRpc().call<AppStoreServiceResult<AppStoreListingsBody>>(
      "appStore.listListings",
      params,
      { timeoutMs: SHORT_RPC_TIMEOUT_MS },
    );
  }

  async getListing(
    params: AppStoreGetParams,
  ): Promise<AppStoreServiceResult<AppStoreListingDetailBody>> {
    return await getWorkerRpc().call<AppStoreServiceResult<AppStoreListingDetailBody>>(
      "appStore.getListing",
      params,
      { timeoutMs: SHORT_RPC_TIMEOUT_MS },
    );
  }
}

/** Worker-side proxy for the live main-process Talk router. */
export class TalkRouterProxy implements TalkRouter {
  list(): Promise<Array<{ connectionId: string; service: string }>> {
    return getWorkerRpc().call("talk.list", {});
  }

  subscribe(
    _connectionId: string,
    _handler: (message: InboundMessage) => Promise<void>,
  ): () => void {
    throw new Error("Talk subscriptions are only available in the main process");
  }

  async send(
    connectionId: string,
    conversationId: ConversationId,
    message: OutgoingMessage,
  ): Promise<MessageReceipt> {
    return getWorkerRpc().call<MessageReceipt>("talk.send", {
      connectionId,
      conversationId,
      message,
    });
  }

  feature<K extends TalkFeatureName>(connectionId: string, name: K): TalkFeatureMap[K] | null {
    if (name !== "history") return null;
    return {
      query: async (input: {
        conversationId?: ConversationId;
        since?: Date;
        limit?: number;
      }): Promise<InboundMessage[]> => {
        const messages = await getWorkerRpc().call<
          Array<Omit<InboundMessage, "timestamp"> & { timestamp: Date | string }>
        >("talk.history.query", {
          connectionId,
          ...input,
          ...(input.since ? { since: input.since.toISOString() } : {}),
        });
        return messages.map((message) => ({
          ...message,
          timestamp:
            message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
        }));
      },
    } as unknown as TalkFeatureMap[K];
  }
}

export class ConversationSettingsControlProxy implements ConversationSettingsControl {
  list(input: ListConversationSettingsInput): Promise<ConversationSettingsPage> {
    return getWorkerRpc().call("conversationSettings.list", input);
  }

  get(ref: ConversationRef): Promise<ConversationSettingsSnapshot> {
    return getWorkerRpc().call("conversationSettings.get", { ref });
  }

  update(input: UpdateConversationSettingsInput): Promise<ConversationSettingsSnapshot> {
    return getWorkerRpc().call("conversationSettings.update", input);
  }

  reset(input: ResetConversationSettingsInput): Promise<ConversationSettingsSnapshot> {
    return getWorkerRpc().call("conversationSettings.reset", input);
  }
}

/**
 * Worker-side stand-in for the main-process `SystemUpgradeService`. The nightly
 * `system_upgrade` action runs in a worker, but the upgrade countdown hub and
 * its timers live in the main process — so the probe forwards to main, where
 * the real service checks Rome Cloud and opens the countdown.
 */
export class SystemUpgradeServiceProxy implements SystemUpgradeChecker {
  async checkAndOffer(): Promise<SystemUpgradeOfferResult> {
    return await getWorkerRpc().call<SystemUpgradeOfferResult>("system.upgrade.checkAndOffer", {});
  }
}

/** Worker-side stand-in for the main-process backend-turn orchestrator. The
 * `resume_session` action runs in a worker (a routine-fired root action →
 * subprocess), but running the turn + delivering its reply needs main-process
 * state (the AgentSession registry, channel adapters, the webchat runtime), so
 * the single `runAndDeliver` forwards there over one RPC. */
export class BackendTurnRunnerProxy implements BackendTurnRunner {
  async runAndDeliver(params: BackendTurnParams): Promise<void> {
    await getWorkerRpc().call("session.continue", params, {
      timeoutMs: BACKEND_TURN_RPC_TIMEOUT_MS,
    });
  }
}

/** Worker-side stand-in for the main-process `NotifyClient`. The
 * `send_notification` action runs in a worker, but the durable instance token
 * must never leave the main process — so the whole send (token read + the
 * `/api/notify` call) happens in main and only the `SendOutcome` returns here.
 * A worker→main transport failure leaves delivery genuinely uncertain (the
 * request may have reached main and Rome Cloud), so the three named transport
 * errors map to `outcome_unknown`; anything else — a no-IPC topology error or a
 * genuine main-handler bug — keeps throwing. */
export class NotifyServiceProxy implements NotifyService {
  async send(content?: NotifyContent): Promise<SendOutcome> {
    try {
      return await getWorkerRpc().call<SendOutcome>("notify.send", content ?? {}, {
        timeoutMs: NOTIFY_RPC_TIMEOUT_MS,
      });
    } catch (err) {
      if (
        err instanceof WorkerRpcTimeoutError ||
        err instanceof WorkerRpcDisconnectError ||
        err instanceof WorkerRpcSendError
      ) {
        return { kind: "outcome_unknown" };
      }
      throw err;
    }
  }
}

/** Worker-side stand-in for the live EmailAdapter's inbound entry point. The
 * real adapter (inbound secret, MailProvider, onMessage pipeline) lives in the
 * main process; `email_inbound` runs in a worker, so it forwards the raw deposit
 * + HMAC to main where the adapter verifies and dispatches it. */
export class EmailInboundControlProxy implements EmailInboundControl {
  async ingest(rawBody: string, signature: string): Promise<EmailInboundResult> {
    return getWorkerRpc().call<EmailInboundResult>("channels.email.ingestInbound", {
      rawBody,
      signature,
    });
  }
}

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

import { getCurrentActionContext } from "@rome-os/app-runtime";
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
  ChildSessionCaller,
  ChildSessions,
  ChildSessionStatusReport,
  ChildSessionStopResult,
  DetachedChildStarted,
  StartDetachedChildInput,
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
  OutgoingMessage,
  ListConversationSettingsInput,
  ResetConversationSettingsInput,
  UpdateConversationSettingsInput,
} from "@rome-os/app-runtime";

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

/** Worker-side stand-in for the main-process owner of detached child agent
 * sessions. `summon` (detached), `summon_status`, and `summon_stop` run in a
 * worker, but the child runs under a session manager that exists only in main.
 *
 * Every method stamps the calling agent identity onto the wire itself. It has
 * to: the RPC server exits the action context before dispatching, so main
 * cannot recover which agent turn asked. A detached child with no parent is
 * unreachable from any later turn, and a child answers only to the agent that
 * owns it, so an unstamped read would belong to nobody. */
export class ChildSessionsProxy implements ChildSessions {
  async startDetached(input: StartDetachedChildInput): Promise<DetachedChildStarted> {
    const parent = input.parent ?? parentFromActionContext();
    return await getWorkerRpc().call<DetachedChildStarted>("childSessions.startDetached", {
      agentName: input.agentName,
      prompt: input.prompt,
      resumeSessionId: input.resumeSessionId,
      workingDir: input.workingDir,
      parent,
    });
  }

  async getStatus(input: {
    sessionId: string;
    transcriptTail?: number;
    caller?: ChildSessionCaller;
  }): Promise<ChildSessionStatusReport | null> {
    return await getWorkerRpc().call<ChildSessionStatusReport | null>("childSessions.getStatus", {
      sessionId: input.sessionId,
      transcriptTail: input.transcriptTail,
      caller: input.caller ?? callerFromActionContext(),
    });
  }

  async stop(input: {
    sessionId: string;
    caller?: ChildSessionCaller;
  }): Promise<ChildSessionStopResult | null> {
    return await getWorkerRpc().call<ChildSessionStopResult | null>("childSessions.stop", {
      sessionId: input.sessionId,
      caller: input.caller ?? callerFromActionContext(),
    });
  }
}

function parentFromActionContext(): NonNullable<StartDetachedChildInput["parent"]> {
  const ctx = getCurrentActionContext();
  if (!ctx?.romeSessionId || !ctx.turnId) {
    throw new Error(
      "a detached child needs an agent-session caller: this action was not invoked from an agent turn",
    );
  }
  return {
    parentSessionId: ctx.romeSessionId,
    parentTurnId: ctx.turnId,
    parentAgentName: ctx.agentName ?? "main",
  };
}

function callerFromActionContext(): ChildSessionCaller {
  const ctx = getCurrentActionContext();
  if (!ctx?.romeSessionId) {
    throw new Error(
      "reading a detached child needs an agent-session caller: a child answers only to the agent that owns it, and this action was not invoked from an agent turn",
    );
  }
  return { romeSessionId: ctx.romeSessionId, agentName: ctx.agentName ?? "main" };
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

import type { ChildProcess } from "node:child_process";
import { actionExecutionContext } from "./context.js";
import { replayContext } from "./replay.js";
import { z } from "zod";
import type { EmailInboundResult } from "../channels/email-control.js";
import type {
  BackendTurnRunner,
  ChildSessions,
  ConversationId,
  ConversationRef,
  ConversationSettingsControl,
  InboundMessage,
  OutgoingMessage,
  TalkRouter,
  UpdateConversationSettingsInput,
  ResetConversationSettingsInput,
  ListConversationSettingsInput,
} from "@rome-os/app-runtime";
import { MAX_CHILD_TRANSCRIPT_TAIL } from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../connections/registry.js";
import type { EventService } from "../events/event-service.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import { toRoutine } from "../db/repositories/routines.js";
import type { AppLifecycleService } from "../apps/lifecycle-service.js";
import type { AppStoreReader } from "../apps/store-service.js";
import type { SystemUpgradeChecker } from "../system-upgrade/service.js";
import type { NotifyService } from "../lib/notify-client.js";
import { SpecSourceSchema } from "../apps/lockfile.js";
import { parseRemixSource } from "../apps/remix-source.js";
import { createLogger } from "../logger.js";

const log = createLogger("worker-rpc");

const AppIdSchema = z.string().min(1);

const TalkSendParams = z.object({
  connectionId: z.string().min(1),
  conversationId: z.string(),
  message: z.custom<OutgoingMessage>((val) => typeof val === "object" && val !== null, {
    message: "message must be an object",
  }),
});

const TalkHistoryParams = z.object({
  connectionId: z.string().min(1),
  conversationId: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().positive().optional(),
});

const ConversationRefParams = z.object({
  ref: z.object({ connectionId: z.string().min(1), conversationId: z.string() }),
});
const ConversationSettingsInput = z.custom<
  UpdateConversationSettingsInput | ResetConversationSettingsInput | ListConversationSettingsInput
>((value) => typeof value === "object" && value !== null);

const EmailIngestInboundParams = z.object({
  rawBody: z.string(),
  signature: z.string(),
});

const RoutineIdParams = z.object({ routineId: z.string().min(1) });
// An optional sender-supplied body. `{}` (the legacy no-arg call) is
// valid; a present body must be a string. `.strict()` so an unknown key on this
// internal wire contract surfaces as an error rather than being silently
// stripped — a typo'd param must not degrade to the default alert unnoticed.
const NotifySendParams = z.object({ body: z.string().optional() }).strict();

const ActionHasParams = z.object({ actionName: z.string().min(1) });
const AgentHasAgentParams = z.object({ name: z.string().min(1) });
const AgentHasActionParams = z.object({
  agentName: z.string().min(1),
  actionName: z.string().min(1),
});

const AppsCreateParams = z.union([
  z
    .object({
      appId: AppIdSchema,
      rootPath: z.string().min(1),
      template: z.enum(["default", "workflow"]).optional(),
    })
    .strict(),
  z
    .object({
      appId: AppIdSchema,
      name: z.string().min(1),
      from: z.unknown(),
    })
    .strict(),
]);

const AppsInstallParams = z.object({
  source: SpecSourceSchema,
  enabled: z.boolean().optional(),
});

const AppsUninstallParams = z.object({
  appId: AppIdSchema,
  purge: z.boolean().optional(),
});

const AppsSetEnabledParams = z.object({
  appId: AppIdSchema,
  enabled: z.boolean(),
});

const AppStoreListListingsParams = z.object({
  query: z.string().optional(),
  sort: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  includeInstalledState: z.boolean().optional(),
});

const AppStoreGetListingParams = z.object({
  listingId: z.string().min(1),
  includeInstalledState: z.boolean().optional(),
});

const EventsPublishParams = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const EventsSearchCatalogParams = z.object({
  query: z.string().default(""),
  limit: z.number().int().positive().max(50).default(10),
});

// Required on the wire, unlike the SDK types: the RPC server dispatches outside
// the caller's action context, so main cannot recover who asked and the
// worker-side proxy must have carried it. A detached child that arrives with no
// parent is unreachable from every later turn, and a read with no caller
// belongs to no agent, so neither has a safe default.
const ChildSessionsCaller = z.object({
  romeSessionId: z.string().min(1),
  agentName: z.string().min(1),
});

const ChildSessionsStartDetachedParams = z.object({
  agentName: z.string().min(1),
  prompt: z.string().min(1),
  resumeSessionId: z.string().min(1).optional(),
  workingDir: z.string().min(1).optional(),
  parent: z.object({
    parentSessionId: z.string().min(1),
    parentTurnId: z.string().min(1),
    parentAgentName: z.string().min(1),
  }),
});

const ChildSessionsGetStatusParams = z.object({
  sessionId: z.string().min(1),
  // Clamped rather than refused, matching the ceiling main applies: an ask for
  // more transcript than exists is not a caller error.
  transcriptTail: z
    .number()
    .int()
    .min(0)
    .transform((tail) => Math.min(tail, MAX_CHILD_TRANSCRIPT_TAIL))
    .optional(),
  caller: ChildSessionsCaller,
});

const ChildSessionsStopParams = z.object({
  sessionId: z.string().min(1),
  caller: ChildSessionsCaller,
});

const SessionContinueParams = z.object({
  agentName: z.string().min(1),
  sessionId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  channel: z.string().min(1),
  threadId: z.string().min(1),
  channelUserId: z.string().optional(),
  prompt: z.string(),
});

function parseParams<T extends z.ZodType>(method: string, schema: T, params: unknown): z.infer<T> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${method}: invalid params — ${issues}`);
}

interface RpcRequestMessage {
  type: "rpc_request";
  clientId: string;
  id: number;
  method: string;
  params: unknown;
}

interface RpcResponseMessage {
  type: "rpc_response";
  clientId: string;
  id: number;
  result?: unknown;
  error?: string;
}

export interface WorkerRpcServices {
  talkRouter: TalkRouter;
  connectionRegistry: ConnectionRegistry;
  conversationSettings: ConversationSettingsControl;
  /** Live routine engine + repo — the action worker has no in-process engine,
   * so it persists a routine then calls `routines.schedule` to activate it here. */
  routinesRepo: RoutinesRepository;
  routineEngine: RoutineEngine;
  /** Event coordinator (bus + catalog). `events.publish` / `events.searchCatalog`
   * delegate the business logic here so it is shared with the main-process
   * action path; the handler only validates the wire params. */
  eventService: EventService;
  /** App lifecycle coordinator (scaffold + AppManager + table purge). The
   * `apps.*` handlers delegate to it; the handler only validates wire params. */
  appLifecycle: AppLifecycleService;
  /** Rome App Store read surface. */
  appStore: AppStoreReader;
  /** Upgrade probe coordinator. The `system_upgrade` action runs in a worker
   * (a routine-fired root action → subprocess), but the countdown hub + timers
   * live in the main process, so `system.upgrade.checkAndOffer` runs the probe
   * here where the hub it drives actually exists. */
  systemUpgrade: SystemUpgradeChecker;
  /** Catalog membership check. Action workers hold an `RpcAgentRunner` that has
   * no local catalog, so `agent.hasAgent` bridges the lookup back to main —
   * this is how the inbox trusted-path fallback (route to `main` when the bound
   * agent was uninstalled) actually runs in the worker runtime. */
  hasAgent: (name: string) => boolean;
  /** Main-process action registry existence check. Worker-local lazy stubs are
   * presence-only, so validation paths such as `create_routine` ask the eager
   * main registry whether an action is actually registered there. */
  hasRegisteredAction: (name: string) => boolean;
  /** Capability check bridged to the worker-side `RpcAgentRunner.hasAction`:
   * does the named agent's allow-list resolve the named action? Mirrors the
   * agent session's own gate so the inbox channel-control cue can match what
   * the routed agent can actually do. Returns false for an unknown agent. */
  hasAction: (agentName: string, actionName: string) => boolean;
  /** Main-process backend-turn orchestrator. The `resume_session` action runs
   * in a worker (a routine-fired root action → subprocess), but running the turn
   * + delivering its reply needs main-only state (AgentSession registry, channel
   * adapters, webchat runtime) — so `session.continue` runs it here. */
  backendTurnRunner: BackendTurnRunner;
  /** Main-process push sender. The `send_notification` action runs in
   * a worker, but the durable instance token must never leave main — so
   * `notify.send` reads the token and calls Rome Cloud's `/api/notify` here and
   * returns only the classified `SendOutcome`. */
  notify: NotifyService;
  /** Main-process owner of detached child agent sessions. The child runs under
   * a process-lifetime session manager that exists only here, so `summon`
   * (detached), `summon_status`, and `summon_stop` forward every call over
   * `childSessions.*`. */
  childSessions: ChildSessions;
}

export class WorkerRpcServer {
  constructor(private services: WorkerRpcServices) {}

  /**
   * In-process entry point for the main process. When an action body runs in
   * main (no parent IPC channel) and calls `getWorkerRpc()`, the SDK falls back
   * to this dispatcher instead of failing — same dispatch path as IPC requests,
   * minus the wire hop. Wired up via `setWorkerRpcInProcessDispatcher`.
   */
  dispatchInProcess(method: string, params: unknown): Promise<unknown> {
    return this.dispatch(method, params);
  }

  attach(worker: ChildProcess): void {
    worker.on("message", (message: unknown) => {
      if (!isRpcRequest(message)) return;
      const request = message;
      // A pooled ChildProcess keeps the async resource created by fork(). If
      // that fork happened while an action replay/execution context was active,
      // every later `message` callback on the reused worker re-enters that old
      // context. Worker RPC is an independent ingress boundary, so never let a
      // creator action's ALS state leak into event/routine dispatch or another
      // main-process service call.
      replayContext.exit(() =>
        actionExecutionContext.exit(() => {
          this.dispatch(request.method, request.params)
            .then((result) => {
              this.respond(worker, request.clientId, request.id, { result });
            })
            .catch((err: unknown) => {
              this.respond(worker, request.clientId, request.id, {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }),
      );
    });
  }

  private respond(
    worker: ChildProcess,
    clientId: string,
    id: number,
    body: { result?: unknown; error?: string },
  ): void {
    if (!worker.connected) return;
    const response: RpcResponseMessage = { type: "rpc_response", clientId, id, ...body };
    worker.send(response, (err) => {
      if (err) {
        log.warn("failed to send rpc response", { id, error: err.message });
      }
    });
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "talk.list":
        return await this.services.talkRouter.list();
      case "talk.send":
        return await this.handleTalkSend(params);
      case "talk.history.query":
        return await this.handleTalkHistory(params);
      case "conversationSettings.list":
        return await this.services.conversationSettings.list(
          parseParams(method, ConversationSettingsInput, params) as ListConversationSettingsInput,
        );
      case "conversationSettings.get": {
        const { ref } = parseParams(method, ConversationRefParams, params);
        return await this.services.conversationSettings.get(ref as ConversationRef);
      }
      case "conversationSettings.update":
        return await this.services.conversationSettings.update(
          parseParams(method, ConversationSettingsInput, params) as UpdateConversationSettingsInput,
        );
      case "conversationSettings.reset":
        return await this.services.conversationSettings.reset(
          parseParams(method, ConversationSettingsInput, params) as ResetConversationSettingsInput,
        );
      case "channels.email.ingestInbound":
        return await this.handleEmailIngestInbound(params);
      case "actions.has":
        return this.handleActionsHas(params);
      case "agent.hasAgent":
        return this.handleAgentHasAgent(params);
      case "agent.hasAction":
        return this.handleAgentHasAction(params);
      case "routines.schedule":
        return await this.handleRoutinesSchedule(params);
      case "routines.cancel":
        return await this.handleRoutinesCancel(params);
      case "events.publish":
        return this.handleEventsPublish(params);
      case "events.searchCatalog":
        return this.handleEventsSearchCatalog(params);
      case "apps.create":
        return await this.handleAppsCreate(params);
      case "apps.install":
        return await this.handleAppsInstall(params);
      case "apps.uninstall":
        return await this.handleAppsUninstall(params);
      case "apps.setEnabled":
        return await this.handleAppsSetEnabled(params);
      case "appStore.listListings":
        return await this.handleAppStoreListListings(params);
      case "appStore.getListing":
        return await this.handleAppStoreGetListing(params);
      case "system.upgrade.checkAndOffer":
        // No params: the probe takes none. All policy (Rome Cloud check,
        // countdown open) runs in the main-process service.
        return await this.services.systemUpgrade.checkAndOffer();
      case "session.continue":
        return await this.handleSessionContinue(params);
      case "childSessions.startDetached":
        return await this.services.childSessions.startDetached(
          parseParams(method, ChildSessionsStartDetachedParams, params),
        );
      case "childSessions.getStatus":
        return await this.services.childSessions.getStatus(
          parseParams(method, ChildSessionsGetStatusParams, params),
        );
      case "childSessions.stop":
        return await this.services.childSessions.stop(
          parseParams(method, ChildSessionsStopParams, params),
        );
      case "notify.send": {
        // The sender reads token/origin from main-process state; the only wire
        // param is the optional body. Preserve the no-body call shape
        // so an absent body is `send(undefined)`, not `send({})`.
        const { body } = parseParams("notify.send", NotifySendParams, params);
        return await this.services.notify.send(body !== undefined ? { body } : undefined);
      }
      default:
        throw new Error(`Unknown WorkerRPC method: ${method}`);
    }
  }

  private async handleAppsCreate(params: unknown): Promise<unknown> {
    const createParams = parseParams("apps.create", AppsCreateParams, params);
    if ("name" in createParams) {
      const from = parseRemixSource(createParams.from);
      if (!from) throw new Error("apps.create: invalid params: invalid Remix source");
      return await this.services.appLifecycle.create({ ...createParams, from });
    }
    return await this.services.appLifecycle.create(createParams);
  }

  private async handleAppsInstall(params: unknown): Promise<unknown> {
    const installParams = parseParams("apps.install", AppsInstallParams, params);
    return await this.services.appLifecycle.install(installParams);
  }

  private async handleAppsUninstall(params: unknown): Promise<unknown> {
    const { appId, purge } = parseParams("apps.uninstall", AppsUninstallParams, params);
    return await this.services.appLifecycle.uninstall({ appId, purge });
  }

  private async handleAppsSetEnabled(params: unknown): Promise<unknown> {
    const { appId, enabled } = parseParams("apps.setEnabled", AppsSetEnabledParams, params);
    return await this.services.appLifecycle.setEnabled({ appId, enabled });
  }

  private async handleAppStoreListListings(params: unknown): Promise<unknown> {
    const parsed = parseParams("appStore.listListings", AppStoreListListingsParams, params);
    return await this.services.appStore.listListings(parsed);
  }

  private async handleAppStoreGetListing(params: unknown): Promise<unknown> {
    const parsed = parseParams("appStore.getListing", AppStoreGetListingParams, params);
    return await this.services.appStore.getListing(parsed);
  }

  private async handleSessionContinue(params: unknown): Promise<{ ok: true }> {
    const turn = parseParams("session.continue", SessionContinueParams, params);
    await this.services.backendTurnRunner.runAndDeliver(turn);
    return { ok: true };
  }

  private async handleTalkSend(params: unknown) {
    const { connectionId, conversationId, message } = parseParams(
      "talk.send",
      TalkSendParams,
      params,
    );
    return await this.services.talkRouter.send(
      connectionId,
      conversationId as ConversationId,
      message,
    );
  }

  private async handleTalkHistory(params: unknown): Promise<InboundMessage[]> {
    const { connectionId, conversationId, since, limit } = parseParams(
      "talk.history.query",
      TalkHistoryParams,
      params,
    );
    const history = this.services.talkRouter.feature(connectionId, "history");
    if (!history) throw new Error(`Talk history is unavailable for connection "${connectionId}"`);
    return history.query({
      ...(conversationId ? { conversationId: conversationId as ConversationId } : {}),
      ...(since ? { since: new Date(since) } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  private async handleEmailIngestInbound(params: unknown): Promise<EmailInboundResult> {
    const { rawBody, signature } = parseParams(
      "channels.email.ingestInbound",
      EmailIngestInboundParams,
      params,
    );
    const connections = (await this.services.talkRouter.list()).filter(
      (connection) => connection.service === "email",
    );
    if (connections.length !== 1) return { status: "skipped", reason: "channel_inactive" };
    return (await this.services.connectionRegistry.ingest(connections[0]!.connectionId, {
      rawBody,
      signature,
    })) as EmailInboundResult;
  }

  /**
   * Plain existence check against the main process's eager ActionRegistry. This
   * is deliberately separate from `agent.hasAction`, which applies a named
   * agent's allow-list.
   */
  private handleActionsHas(params: unknown): { hasAction: boolean } {
    const { actionName } = parseParams("actions.has", ActionHasParams, params);
    return { hasAction: this.services.hasRegisteredAction(actionName) };
  }

  /**
   * Catalog membership check for the worker-side `RpcAgentRunner.hasAgent`.
   * Lets the inbox trusted-path fallback decide whether a channel's bound agent
   * still exists (vs. was uninstalled) without coupling the worker to the
   * in-process `AgentLoader`.
   */
  private handleAgentHasAgent(params: unknown): { hasAgent: boolean } {
    const { name } = parseParams("agent.hasAgent", AgentHasAgentParams, params);
    return { hasAgent: this.services.hasAgent(name) };
  }

  /**
   * Capability check for the worker-side `RpcAgentRunner.hasAction`. Lets the
   * inbox trusted path decide whether a bound app agent can actually call an
   * action without coupling the worker to the in-process `AgentLoader` /
   * `ActionRegistry`.
   */
  private handleAgentHasAction(params: unknown): { hasAction: boolean } {
    const { agentName, actionName } = parseParams("agent.hasAction", AgentHasActionParams, params);
    return { hasAction: this.services.hasAction(agentName, actionName) };
  }

  private async handleRoutinesSchedule(params: unknown): Promise<{ ok: true }> {
    const { routineId } = parseParams("routines.schedule", RoutineIdParams, params);
    const row = await this.services.routinesRepo.findById(routineId);
    if (!row) throw new Error(`Routine not found: ${routineId}`);
    if (row.enabled ?? true) {
      await this.services.routineEngine.activate(toRoutine(row));
    } else {
      await this.services.routineEngine.deactivate(routineId);
    }
    return { ok: true };
  }

  private async handleRoutinesCancel(params: unknown): Promise<{ ok: true }> {
    const { routineId } = parseParams("routines.cancel", RoutineIdParams, params);
    await this.services.routineEngine.deactivate(routineId);
    return { ok: true };
  }

  private async handleEventsPublish(params: unknown): Promise<{ accepted: true }> {
    const { name, source, payload } = parseParams("events.publish", EventsPublishParams, params);
    return await this.services.eventService.publish({ name, source, payload });
  }

  private async handleEventsSearchCatalog(params: unknown): Promise<unknown> {
    const { query, limit } = parseParams("events.searchCatalog", EventsSearchCatalogParams, params);
    return await this.services.eventService.search(query, limit);
  }
}

function isRpcRequest(message: unknown): message is RpcRequestMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: string }).type === "rpc_request" &&
    typeof (message as { clientId?: unknown }).clientId === "string"
  );
}

import { webchatCaller } from "../../chats/dashboard/dashboard-account.js";
import type { IpcCallContext, IpcRpc } from "./ipc.js";
import type { ApprovalCard } from "./approval-card.js";
import { z } from "zod";
import { parseWorkerCallParams } from "../../lib/worker-call-params.js";
import { runWithHookInvocationContext } from "../../core/hook-recursion.js";
import type { EmailInboundResult } from "../../connections/kinds/email/email-control.js";
import { emailConnection } from "../accounts-service.js";
import type { ChannelOf } from "../../chats/connected-accounts/connection-ports.js";
import type {
  BackendTurnRunner,
  ChatId,
  ChatRef,
  ChatSettingsControl,
  ChannelMessage,
  OutgoingMessage,
  ChannelsService,
  MessageReceipt,
  UpdateChatSettingsInput,
  ResetChatSettingsInput,
  ListChatSettingsInput,
  PreviewPayload,
  ThreadContext,
} from "@rome-os/app-runtime";
import type { ConnectionRegistry } from "../../connections/registry.js";
import type { EventService } from "../../events/event-service.js";
import type { AppLifecycleService } from "../lifecycle-service.js";
import type { AppStoreReader } from "../store-service.js";
import type { AgentNamesService } from "../../chats/accounts/agent-names.js";
import type { SendOutcome, SystemNotifyContent } from "../../lib/notify-client.js";
import type { ConciergeOwner } from "../../concierge/owner.js";
import { actionCaller, sendForCaller } from "./caller-notify.js";
import type { MainBackendTurnRunner } from "./backend-turn.js";
import { SpecSourceSchema } from "../lockfile.js";
import { parseRemixSource } from "../remix-source.js";
import type {
  AppConnectionBrokerPort,
  AppConnectionBrokerResult,
} from "../../connections/app-connections.js";

const AppIdSchema = z.string().min(1);

// An app names one of Rome's accounts, or a channel by its name.
const AccountOrChannel = z.union([
  z.string().min(1),
  z.object({ platform: z.string().min(1), id: z.string().min(1) }).strict(),
]);

// An approval's card, which a worker asks main to put in the conversation the
// approval came from, so it is recorded in that chat as main records it.
const ApprovalCardParams = z.object({
  approvalId: z.string(),
  actionName: z.string(),
  preview: z.custom<PreviewPayload>((val) => typeof val === "object" && val !== null).optional(),
  channelContext: z
    .custom<ThreadContext>((val) => typeof val === "object" && val !== null)
    .optional(),
});

const ChannelsSendParams = z.object({
  channel: AccountOrChannel,
  chatId: z.string(),
  message: z.custom<OutgoingMessage>((val) => typeof val === "object" && val !== null, {
    message: "message must be an object",
  }),
});

// `query` reads the channel's own `messages`, which names no Connection, so a
// request naming one is refused rather than answered from another account.
const ChannelsQueryParams = z
  .object({
    channel: AccountOrChannel,
    chatId: z.string().optional(),
    since: z.string().datetime().optional(),
    after: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const AgentNamesResolveParams = z.object({ name: z.string().min(1) }).strict();

const ChatRefParams = z.object({
  ref: z.object({ connectionId: z.string().min(1), chatId: z.string() }),
});
const ChatSettingsInput = z.custom<
  UpdateChatSettingsInput | ResetChatSettingsInput | ListChatSettingsInput
>((value) => typeof value === "object" && value !== null);

const EmailIngestInboundParams = z.object({
  rawBody: z.string(),
  signature: z.string(),
});

// An optional sender-supplied body. `{}` (the legacy no-arg call) is
// valid; a present body must be a string. `.strict()` so an unknown key on this
// internal wire contract surfaces as an error rather than being silently
// stripped — a typo'd param must not degrade to the default alert unnoticed.
const NotifySendParams = z.object({ body: z.string().optional() }).strict();

const ActionHasParams = z.object({ actionName: z.string().min(1) });
const ActionValidateArgsParams = z.object({
  actionName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
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

// The hook chain of the worker-side caller. An install or an enable starts
// the app, and the app-started dispatch reads the chain from the async context
// of the catalog refresh, so the handler restores it around the call.
const HookInvocationContextParam = z.object({
  rootInvocationId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  chain: z.array(
    z.object({
      hookType: z.string().min(1),
      appId: z.string().min(1),
      hookName: z.string().min(1),
    }),
  ),
});

const AppsInstallParams = z.object({
  source: SpecSourceSchema,
  enabled: z.boolean().optional(),
  hookInvocationContext: HookInvocationContextParam.optional(),
});

const AppsUninstallParams = z.object({
  appId: AppIdSchema,
  purge: z.boolean().optional(),
  hookInvocationContext: HookInvocationContextParam.optional(),
});

const AppsSetEnabledParams = z.object({
  appId: AppIdSchema,
  enabled: z.boolean(),
  hookInvocationContext: HookInvocationContextParam.optional(),
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
  match: z.record(z.string(), z.string()).optional(),
});

const SessionContinueParams = z.object({
  agentName: z.string().min(1),
  sessionId: z.string().min(1),
  channel: z.string().min(1),
  threadId: z.string().min(1),
  channelUserId: z.string().optional(),
  prompt: z.string(),
  ownerKey: z.string().optional(),
});

const AppConnectionsListParams = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
const AppConnectionsIdentityParams = z
  .object({ connectionId: z.string().min(1), identity: z.string().min(1) })
  .strict();
const AppConnectionsOperationsParams = AppConnectionsIdentityParams.extend({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
}).strict();
const AppConnectionsInvokeParams = AppConnectionsIdentityParams.extend({
  operation: z.string().min(1),
  input: z.unknown().optional(),
  requestId: z.string().optional(),
}).strict();

function parseAppConnectionParams<T extends z.ZodType>(
  method: string,
  schema: T,
  params: unknown,
): AppConnectionBrokerResult<z.infer<T>> {
  try {
    return { ok: true, value: parseWorkerCallParams(method, schema, params) };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "The App connection request is invalid.",
        retryable: false,
      },
    };
  }
}

export interface WorkerRpcServices {
  /** How a worker's actions send and read on channels (`channels.*`). */
  channelsService: ChannelsService;
  connectionRegistry: ConnectionRegistry;
  channelOf: ChannelOf;
  chatSettings: ChatSettingsControl;
  /** Event coordinator (bus + catalog). `events.publish` / `events.searchCatalog`
   * delegate the business logic here so it is shared with the main-process
   * action path; the handler only validates the wire params. */
  eventService: EventService;
  /** App lifecycle coordinator (scaffold + AppManager + table purge). The
   * `apps.*` handlers delegate to it; the handler only validates wire params. */
  appLifecycle: AppLifecycleService;
  /** Rome App Store read surface. */
  appStore: AppStoreReader;
  /** Main-process action registry existence check. Worker-local lazy stubs are
   * presence-only, so validation paths such as `create_routine` ask the eager
   * main registry whether an action is actually registered there. */
  hasRegisteredAction: (name: string) => boolean;
  isExplicitAction: (name: string) => boolean;
  /** Checks args against the main registry's input schema for the action, the
   * one worker-local lazy stubs lack. Returns an error message, or null when
   * the args fit, the action declares no schema, or the action is unknown. */
  validateActionArgs: (name: string, args: Record<string, unknown>) => string | null;
  /** Main-process backend-turn orchestrator. The `resume_session` action runs
   * in a worker (a routine-fired root action → subprocess), but running the turn
   * + delivering its reply needs main-only state (AgentSession registry, channel
   * adapters, webchat runtime) — so `session.continue` runs it here. */
  backendTurnRunner: Pick<MainBackendTurnRunner, "runAndDeliver">;
  /** Main-process push sender. The `send_notification` action runs in
   * a worker, but the durable instance token must never leave main — so
   * `notify.send` reads the token and calls Rome Cloud's `/api/notify` here and
   * returns only the classified `SendOutcome`. */
  notify: { send(content?: SystemNotifyContent): Promise<SendOutcome> };
  /** The one person a dashboard chat is private to, or null for a shared chat: a push it calls for rings them. */
  privateOwnerOf: (chatId: string) => Promise<ConciergeOwner | null>;
  /** System-only: how `system:send_message` turns an agent's name into its id. */
  agentNames: AgentNamesService;
  appConnections: AppConnectionBrokerPort;
  /** Resolve the owner from the action that the Core IPC boundary captured. */
  appIdForAction: (actionName: string) => string | null;
  /** Puts an approval's card in the conversation it came from, recorded in
   *  that chat (`approvals.sendCard`). */
  sendApprovalCard: (approval: ApprovalCard) => Promise<void>;
}

/** The person and the dashboard chat behind an action's call across the worker boundary. */
function callerOf(context: IpcCallContext | undefined) {
  return actionCaller(context?.callerActionContext);
}

/** A method served to app workers: it takes the call's params and returns its result. */
export type WorkerRpcHandler = (params: unknown, context?: IpcCallContext) => unknown;

export class WorkerRpcServer {
  private readonly handlers: Map<string, WorkerRpcHandler>;

  /**
   * `calls` are methods another context serves to app workers, such as
   * Routines' `routines.schedule`. A name that a built-in method already
   * takes is refused.
   */
  constructor(
    private services: WorkerRpcServices,
    calls: Readonly<Record<string, WorkerRpcHandler>> = {},
  ) {
    this.handlers = new Map<string, WorkerRpcHandler>(
      Object.entries({
        "channels.list": () => this.services.channelsService.list(),
        "channels.send": (params, context) => this.handleChannelsSend(params, context),
        "approvals.sendCard": (params) =>
          this.services.sendApprovalCard(
            parseWorkerCallParams("approvals.sendCard", ApprovalCardParams, params),
          ),
        "channels.query": (params, context) => this.handleChannelsQuery(params, context),
        "agentNames.resolve": (params) => {
          const { name } = parseWorkerCallParams(
            "agentNames.resolve",
            AgentNamesResolveParams,
            params,
          );
          return this.services.agentNames.resolve(name);
        },
        "chatSettings.list": (params) =>
          this.services.chatSettings.list(
            parseWorkerCallParams(
              "chatSettings.list",
              ChatSettingsInput,
              params,
            ) as ListChatSettingsInput,
          ),
        "chatSettings.get": (params) => {
          const { ref } = parseWorkerCallParams("chatSettings.get", ChatRefParams, params);
          return this.services.chatSettings.get(ref as ChatRef);
        },
        "chatSettings.update": (params) =>
          this.services.chatSettings.update(
            parseWorkerCallParams(
              "chatSettings.update",
              ChatSettingsInput,
              params,
            ) as UpdateChatSettingsInput,
          ),
        "chatSettings.reset": (params) =>
          this.services.chatSettings.reset(
            parseWorkerCallParams(
              "chatSettings.reset",
              ChatSettingsInput,
              params,
            ) as ResetChatSettingsInput,
          ),
        "channels.email.ingestInbound": (params) => this.handleEmailIngestInbound(params),
        "actions.has": (params) => this.handleActionsHas(params),
        "actions.isExplicit": (params) => this.handleActionsIsExplicit(params),
        "actions.validateArgs": (params) => this.handleActionsValidateArgs(params),
        "events.publish": (params) => this.handleEventsPublish(params),
        "events.searchCatalog": (params) => this.handleEventsSearchCatalog(params),
        "apps.create": (params) => this.handleAppsCreate(params),
        "apps.install": (params) => this.handleAppsInstall(params),
        "apps.uninstall": (params) => this.handleAppsUninstall(params),
        "apps.setEnabled": (params) => this.handleAppsSetEnabled(params),
        "appStore.listListings": (params) => this.handleAppStoreListListings(params),
        "appStore.getListing": (params) => this.handleAppStoreGetListing(params),
        // No params: the probe takes none. All policy (Rome Cloud check,
        // countdown open) runs in the main-process service.
        "session.continue": (params, context) => this.handleSessionContinue(params, context),
        "notify.send": (params, context) => {
          // The sender reads token/origin from main-process state; the only wire
          // param is the optional body. Preserve the no-body call shape
          // so an absent body is `send(undefined)`, not `send({})`. Whose
          // phone it rings comes from the caller the IPC boundary captured.
          const { body } = parseWorkerCallParams("notify.send", NotifySendParams, params);
          return sendForCaller(
            this.services.notify,
            this.services.privateOwnerOf,
            callerOf(context),
            body !== undefined ? { body } : undefined,
          );
        },
        "connections.app.list": (params, context) =>
          this.handleAppConnections("list", params, context),
        "connections.app.describe": (params, context) =>
          this.handleAppConnections("describe", params, context),
        "connections.app.operations": (params, context) =>
          this.handleAppConnections("operations", params, context),
        "connections.app.invoke": (params, context) =>
          this.handleAppConnections("invoke", params, context),
      }),
    );
    for (const [method, handler] of Object.entries(calls)) {
      if (this.handlers.has(method)) {
        throw new Error(`WorkerRPC: method ${method} is already served`);
      }
      this.handlers.set(method, handler);
    }
  }

  /** Serve every method on a worker's IPC channel. */
  register(rpc: IpcRpc): void {
    for (const [method, handler] of this.handlers) {
      rpc.handle(method, async (params, context) => await handler(params, context));
    }
  }

  /**
   * In-process entry point for the main process. When an action body runs in
   * main (no parent IPC channel) and calls `callMain()`, it falls back to this
   * dispatcher, which runs the same handlers minus the wire hop. Wired up via
   * `setWorkerRpcInProcessDispatcher`.
   */
  async dispatchInProcess(method: string, params: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Unknown WorkerRPC method: ${method}`);
    return await handler(params);
  }

  private async handleAppConnections(
    method: "list" | "describe" | "operations" | "invoke",
    params: unknown,
    context?: IpcCallContext,
  ): Promise<unknown> {
    const actionName = context?.callerActionName;
    const appId = actionName ? this.services.appIdForAction(actionName) : null;
    if (!appId) {
      return {
        ok: false,
        error: {
          code: "access_denied",
          message: "Connection access requires an App-owned action context.",
          retryable: false,
        },
      };
    }
    switch (method) {
      case "list": {
        const parsed = parseAppConnectionParams(
          "connections.app.list",
          AppConnectionsListParams,
          params,
        );
        if (!parsed.ok) return parsed;
        return await this.services.appConnections.list(appId, parsed.value);
      }
      case "describe": {
        const parsed = parseAppConnectionParams(
          "connections.app.describe",
          AppConnectionsIdentityParams,
          params,
        );
        if (!parsed.ok) return parsed;
        return await this.services.appConnections.describe(appId, parsed.value);
      }
      case "operations": {
        const parsed = parseAppConnectionParams(
          "connections.app.operations",
          AppConnectionsOperationsParams,
          params,
        );
        if (!parsed.ok) return parsed;
        return await this.services.appConnections.operations(appId, parsed.value);
      }
      case "invoke": {
        const parsed = parseAppConnectionParams(
          "connections.app.invoke",
          AppConnectionsInvokeParams,
          params,
        );
        if (!parsed.ok) return parsed;
        return await this.services.appConnections.invoke(
          appId,
          parsed.value,
          context?.callerActionContext,
        );
      }
    }
  }

  private async handleAppsCreate(params: unknown): Promise<unknown> {
    const createParams = parseWorkerCallParams("apps.create", AppsCreateParams, params);
    if ("name" in createParams) {
      const from = parseRemixSource(createParams.from);
      if (!from) throw new Error("apps.create: invalid params: invalid Remix source");
      return await this.services.appLifecycle.create({ ...createParams, from });
    }
    return await this.services.appLifecycle.create(createParams);
  }

  // Each lifecycle handler runs under the caller's hook chain, or under none.
  // Running under none is deliberate: a pooled worker's IPC callback carries
  // the async context of whatever forked it, which is not this caller's.
  private async handleAppsInstall(params: unknown): Promise<unknown> {
    const { hookInvocationContext, ...installParams } = parseWorkerCallParams(
      "apps.install",
      AppsInstallParams,
      params,
    );
    return await runWithHookInvocationContext(hookInvocationContext, () =>
      this.services.appLifecycle.install(installParams),
    );
  }

  private async handleAppsUninstall(params: unknown): Promise<unknown> {
    const { appId, purge, hookInvocationContext } = parseWorkerCallParams(
      "apps.uninstall",
      AppsUninstallParams,
      params,
    );
    return await runWithHookInvocationContext(hookInvocationContext, () =>
      this.services.appLifecycle.uninstall({ appId, purge }),
    );
  }

  private async handleAppsSetEnabled(params: unknown): Promise<unknown> {
    const { appId, enabled, hookInvocationContext } = parseWorkerCallParams(
      "apps.setEnabled",
      AppsSetEnabledParams,
      params,
    );
    return await runWithHookInvocationContext(hookInvocationContext, () =>
      this.services.appLifecycle.setEnabled({ appId, enabled }),
    );
  }

  private async handleAppStoreListListings(params: unknown): Promise<unknown> {
    const parsed = parseWorkerCallParams(
      "appStore.listListings",
      AppStoreListListingsParams,
      params,
    );
    return await this.services.appStore.listListings(parsed);
  }

  private async handleAppStoreGetListing(params: unknown): Promise<unknown> {
    const parsed = parseWorkerCallParams("appStore.getListing", AppStoreGetListingParams, params);
    return await this.services.appStore.getListing(parsed);
  }

  private async handleSessionContinue(
    params: unknown,
    context?: IpcCallContext,
  ): Promise<{ ok: true }> {
    const turn = parseWorkerCallParams("session.continue", SessionContinueParams, params);
    // The woken turn acts for the person of the action that woke it, as the
    // IPC boundary captured them, such as the person whose reminder fired.
    const actor = context?.callerActionContext?.actor;
    await this.services.backendTurnRunner.runAndDeliver(turn, actor ? { actor } : undefined);
    return { ok: true };
  }

  private async handleChannelsSend(
    params: unknown,
    context?: IpcCallContext,
  ): Promise<MessageReceipt> {
    const { channel, chatId, message } = parseWorkerCallParams(
      "channels.send",
      ChannelsSendParams,
      params,
    );
    // The dashboard chat writes only where the calling action's person may.
    return await webchatCaller.run(callerOf(context), () =>
      this.services.channelsService.send(channel, chatId as ChatId, message),
    );
  }

  private async handleChannelsQuery(
    params: unknown,
    context?: IpcCallContext,
  ): Promise<ChannelMessage[]> {
    const { channel, chatId, since, after, limit } = parseWorkerCallParams(
      "channels.query",
      ChannelsQueryParams,
      params,
    );
    // The dashboard chat reads as the person accountable for the calling
    // action's turn, in the chat it runs in.
    return await webchatCaller.run(callerOf(context), () =>
      this.services.channelsService.query(channel, {
        ...(chatId ? { chatId: chatId as ChatId } : {}),
        ...(since ? { since: new Date(since) } : {}),
        ...(after ? { after } : {}),
        ...(limit ? { limit } : {}),
      }),
    );
  }

  private async handleEmailIngestInbound(params: unknown): Promise<EmailInboundResult> {
    const { rawBody, signature } = parseWorkerCallParams(
      "channels.email.ingestInbound",
      EmailIngestInboundParams,
      params,
    );
    const email = emailConnection(this.services.connectionRegistry, this.services.channelOf);
    if (!email) return { status: "skipped", reason: "channel_inactive" };
    return (await this.services.connectionRegistry.ingest(email.id, {
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
    const { actionName } = parseWorkerCallParams("actions.has", ActionHasParams, params);
    return { hasAction: this.services.hasRegisteredAction(actionName) };
  }

  /** Visibility check for the worker-side create_routine explicit-target gate. */
  private handleActionsIsExplicit(params: unknown): { explicit: boolean } {
    const { actionName } = parseWorkerCallParams("actions.isExplicit", ActionHasParams, params);
    return { explicit: this.services.isExplicitAction(actionName) };
  }

  /** Input-schema check for the worker-side create_routine args gate. */
  private handleActionsValidateArgs(params: unknown): { error: string | null } {
    const { actionName, args } = parseWorkerCallParams(
      "actions.validateArgs",
      ActionValidateArgsParams,
      params,
    );
    return { error: this.services.validateActionArgs(actionName, args) };
  }

  private async handleEventsPublish(params: unknown): Promise<{ accepted: true }> {
    const { name, source, payload } = parseWorkerCallParams(
      "events.publish",
      EventsPublishParams,
      params,
    );
    return await this.services.eventService.publish({ name, source, payload });
  }

  private async handleEventsSearchCatalog(params: unknown): Promise<unknown> {
    const { query, limit, match } = parseWorkerCallParams(
      "events.searchCatalog",
      EventsSearchCatalogParams,
      params,
    );
    return await this.services.eventService.search(query, limit, match ? { match } : {});
  }
}

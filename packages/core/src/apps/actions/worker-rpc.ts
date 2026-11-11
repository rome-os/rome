import type { IpcCallContext, IpcRpc } from "./ipc.js";
import type { ApprovalCard } from "./approval-card.js";
import { z } from "zod";
import { parseWorkerCallParams } from "../../lib/worker-call-params.js";
import { runWithHookInvocationContext } from "../../core/hook-recursion.js";
import type { BackendTurnRunner, PreviewPayload, ThreadContext } from "@rome-os/app-runtime";
import type { EventService } from "../../events/event-service.js";
import type { AppLifecycleService } from "../lifecycle-service.js";
import type { AppStoreReader } from "../store-service.js";
import { SpecSourceSchema } from "../lockfile.js";
import { parseRemixSource } from "../remix-source.js";

const AppIdSchema = z.string().min(1);

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

export interface WorkerRpcServices {
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
  /** Puts an approval's card in the conversation it came from, recorded in
   *  that chat (`approvals.sendCard`). */
  sendApprovalCard: (approval: ApprovalCard) => Promise<void>;
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
        "approvals.sendCard": (params) =>
          this.services.sendApprovalCard(
            parseWorkerCallParams("approvals.sendCard", ApprovalCardParams, params),
          ),
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

import { createAppLogger } from "../logger.js";
import { importModuleWithCacheBuster } from "../apps/actions/module-loader.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { DrizzleDb } from "../db/index.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type {
  AppRuntimeRepositories,
  RomeAppApiHandler,
  RomeAppApiRequest,
  RomeAppCaller,
} from "@rome-os/app-runtime";
import type { AppCatalog } from "../apps/catalog.js";
import { type AppView, isResolvedApp, type ResolvedApp } from "../apps/state.js";
import {
  createRomeAppContext,
  runWithRomeAppApiRequestContext,
  type RomeAppContext,
} from "../apps/context.js";
import type { RomeAppViewer } from "../access/visitor-session.js";
import type { AppFavorRequests } from "../apps/app-favors-port.js";
import type { AppConnectionsContextFactory } from "../apps/app-connections-port.js";

export type { RomeAppApiHandler, RomeAppApiRequest, RomeAppCaller } from "@rome-os/app-runtime";

/**
 * Host-side per-request context the dispatcher carries alongside the request —
 * deliberately NOT on the request object, so it never reaches app code. The
 * visitor session here retains `favorViewerToken`, which `ctx.favors` needs
 * and app handlers must never see.
 */
export interface RomeAppApiDispatchContext {
  viewer?: RomeAppViewer;
}

interface RomeAppApiModule {
  createApiHandler?: (ctx: RomeAppContext) => RomeAppApiHandler;
}

export class AppApiDispatcher {
  constructor(
    private readonly catalog: AppCatalog,
    private readonly services: {
      db: DrizzleDb;
      actionEngine: ActionEngine;
      routinesRepo?: RoutinesRepository;
      repositories: AppRuntimeRepositories;
      favorService?: AppFavorRequests;
      appConnections?: AppConnectionsContextFactory;
    },
  ) {}

  async dispatch(
    appId: string,
    request: RomeAppApiRequest,
    context: RomeAppApiDispatchContext = {},
  ): Promise<Response> {
    const view = this.catalog.get(appId);
    if (!isResolvedWithApi(view)) {
      throw new Error(`App "${appId}" has no API entrypoint`);
    }
    const app = view;
    const module = (await importModuleWithCacheBuster(app.api.entryPath)) as RomeAppApiModule;

    if (typeof module.createApiHandler !== "function") {
      throw new Error(
        `App "${appId}" API module must export createApiHandler(ctx) from ${app.api.entryPath}`,
      );
    }

    const handler = module.createApiHandler(
      createRomeAppContext(app, {
        catalog: this.catalog,
        db: this.services.db,
        actionEngine: this.services.actionEngine,
        routinesRepo: this.services.routinesRepo,
        repositories: this.services.repositories,
        favorService: this.services.favorService,
        appConnections: this.services.appConnections,
        whenWorkersBusy: whenWorkersBusyFor(request.caller),
      }),
    );

    if (!handler || typeof handler.handle !== "function") {
      throw new Error(`App "${appId}" API handler must expose handle(request)`);
    }

    const log = createAppLogger("app-api", appId);
    const fields = { appId, method: request.method, path: request.path };
    log.info("dispatching app api request", { ...fields, entryPath: app.api.entryPath });

    // The handler runs on the HTTP process's event loop, so a slow one delays
    // every other request (#2144). Record how long each took, and warn on a
    // slow one so a single query names it. A streamed response counts until
    // its Response is returned, not until the stream ends.
    const startedAt = performance.now();
    let status: number | "threw" = "threw";
    try {
      const response = await runWithRomeAppApiRequestContext({ viewer: context.viewer }, () =>
        handler.handle(request),
      );
      status = response.status;
      return response;
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      const level = durationMs >= SLOW_APP_API_REQUEST_MS ? "warn" : "info";
      log[level]("app api request completed", { ...fields, status, durationMs });
    }
  }
}

/** An app API request at least this slow is logged as a warning. */
const SLOW_APP_API_REQUEST_MS = 1_000;

/** A request from outside the instance (an external webhook, a relay replay,
 * a browser session) has no action worker waiting on it, so its app calls may
 * queue for a worker. A loopback caller can be an agent, or the agent's
 * browser, whose turn a worker drives, so its calls fail fast. */
function whenWorkersBusyFor(caller: RomeAppCaller): "fail" | "queue" {
  return caller.kind === "guardian" && caller.via === "loopback" ? "fail" : "queue";
}

function isResolvedWithApi(
  view: AppView | null | undefined,
): view is ResolvedApp & { api: NonNullable<ResolvedApp["api"]> } {
  return isResolvedApp(view) && view.api != null;
}

export type { AppDbContext, RomeAppContext } from "../apps/context.js";

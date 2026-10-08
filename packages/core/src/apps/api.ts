import { createAppLogger } from "../logger.js";
import { importModuleWithCacheBuster } from "../actions/module-loader.js";
import type { ActionEngine } from "../actions/engine.js";
import type { DrizzleDb } from "../db/index.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { AppRuntimeRepositories } from "@rome-os/app-runtime";
import type { AppCatalog } from "./catalog.js";
import type { ResolvedApp } from "./state.js";
import {
  createRomeAppContext,
  runWithRomeAppApiRequestContext,
  type RomeAppContext,
} from "./context.js";
import type { RomeAppViewer } from "../lib/visitor-session.js";
import type { FavorService } from "../favors/types.js";

/**
 * Who is making this app-api request, resolved server-side by the host before
 * the request reaches an app handler — the app never has to (and must not)
 * derive identity from headers itself.
 *
 * - `guardian` — a valid guardian dashboard session (`via: "cookie"`), or a
 *   trusted in-container loopback caller such as the agent or the agent
 *   browser (`via: "loopback"`; see `lib/trusted-loopback.ts` for why this is
 *   not forgeable from outside).
 * - `visitor` — a verified Rome Cloud visitor session (cloud-email access).
 * - `anonymous` — neither; on a public app this is any internet caller.
 *
 * A guardian who also holds a visitor session resolves as `guardian`; the
 * visitor session itself (including its favor token) stays host-side in the
 * dispatch context, where `ctx.favors` reads it.
 */
export type RomeAppCaller =
  | { kind: "guardian"; userId: string; via: "cookie" | "loopback" }
  | { kind: "visitor"; accountId: string; email: string }
  | { kind: "anonymous" };

export interface RomeAppApiRequest {
  method: string;
  path: string[];
  headers: Record<string, string>;
  query: URLSearchParams;
  body?: Uint8Array;
  /** Resolved caller identity — the single trustworthy "who is calling" answer. */
  caller: RomeAppCaller;
}

/**
 * Host-side per-request context the dispatcher carries alongside the request —
 * deliberately NOT on the request object, so it never reaches app code. The
 * visitor session here retains `favorViewerToken`, which `ctx.favors` needs
 * and app handlers must never see.
 */
export interface RomeAppApiDispatchContext {
  viewer?: RomeAppViewer;
}

export interface RomeAppApiHandler {
  handle(request: RomeAppApiRequest): Promise<Response>;
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
      favorService?: FavorService;
    },
  ) {}

  async dispatch(
    appId: string,
    request: RomeAppApiRequest,
    context: RomeAppApiDispatchContext = {},
  ): Promise<Response> {
    const view = this.catalog.get(appId);
    if (!view || !isResolvedWithApi(view)) {
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
        whenWorkersBusy: whenWorkersBusyFor(request.caller),
      }),
    );

    if (!handler || typeof handler.handle !== "function") {
      throw new Error(`App "${appId}" API handler must expose handle(request)`);
    }

    createAppLogger("app-api", appId).info("dispatching app api request", {
      appId,
      method: request.method,
      path: request.path,
      entryPath: app.api.entryPath,
    });

    return await runWithRomeAppApiRequestContext({ viewer: context.viewer }, () =>
      handler.handle(request),
    );
  }
}

/** A request from outside the instance (an external webhook, a relay replay,
 * a browser session) has no action worker waiting on it, so its app calls may
 * queue for a worker. A loopback caller can be an agent, or the agent's
 * browser, whose turn a worker drives, so its calls fail fast. */
function whenWorkersBusyFor(caller: RomeAppCaller): "fail" | "queue" {
  return caller.kind === "guardian" && caller.via === "loopback" ? "fail" : "queue";
}

function isResolvedWithApi(
  view: unknown,
): view is ResolvedApp & { api: NonNullable<ResolvedApp["api"]> } {
  const candidate = view as ResolvedApp;
  return candidate.manifest !== undefined && candidate.api != null;
}

export type { AppDbContext, RomeAppContext } from "./context.js";

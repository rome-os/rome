// The `turn-middleware` hooks installed apps offer (docs/concepts/apps.md),
// run as an ordered onion around producing a turn's reply. The composition
// root reloads them on every app catalog event.

import type { TurnMiddlewareContext, TurnMiddlewareHook } from "@rome-os/app-runtime";
import type { AppCatalog } from "./catalog.js";
import type { RomeAppRuntimeServices } from "./context.js";
import type { ArtifactRef } from "./state.js";
import { loadAppHook } from "./hook-loader.js";
import { createLogger } from "../logger.js";
import { wrapHookSpan } from "../telemetry.js";
import type { TurnMiddleware } from "../agent/index.js";

const log = createLogger("middleware-chain");

const HOOK_NAME = "turn-middleware";

export interface TurnMiddlewareLoadFailure {
  appId: string;
  path: string;
  error: string;
}

export interface LoadedMiddleware {
  appId: string;
  hook: TurnMiddlewareHook;
}

export class AppTurnMiddleware implements TurnMiddleware {
  private middlewares: LoadedMiddleware[] = [];

  constructor(private readonly options: { appRuntimeServices?: RomeAppRuntimeServices } = {}) {}

  /** Reloads every `turn-middleware` hook. A hook that fails to load is
   *  dropped and reported, never fatal. */
  async loadFromCatalog(catalog: AppCatalog): Promise<TurnMiddlewareLoadFailure[]> {
    const { middlewares, failures } = await this.read(catalog, catalog.listArtifacts("hook"));
    this.middlewares = sortByOrder(middlewares);
    return failures;
  }

  /** Loads one app's `turn-middleware` hooks without adding them. */
  loadApp(
    catalog: AppCatalog,
    appId: string,
  ): Promise<{ middlewares: LoadedMiddleware[]; failures: TurnMiddlewareLoadFailure[] }> {
    return this.read(
      catalog,
      catalog.listArtifacts("hook").filter((artifact) => artifact.ownerId === appId),
    );
  }

  /** Adds one middleware in its order and returns its undo, which removes that middleware only. */
  add(middleware: LoadedMiddleware): () => void {
    this.middlewares = sortByOrder([...this.middlewares, middleware]);
    return () => {
      this.middlewares = this.middlewares.filter((entry) => entry !== middleware);
    };
  }

  private async read(
    catalog: AppCatalog,
    artifacts: readonly ArtifactRef[],
  ): Promise<{ middlewares: LoadedMiddleware[]; failures: TurnMiddlewareLoadFailure[] }> {
    const failures: TurnMiddlewareLoadFailure[] = [];
    const middlewares: LoadedMiddleware[] = [];

    for (const artifact of artifacts) {
      if (artifact.publicName !== HOOK_NAME) continue;
      try {
        const hook = await loadAppHook(artifact, catalog, this.options.appRuntimeServices);
        assertTurnMiddleware(hook, artifact);
        middlewares.push({ appId: artifact.ownerId, hook });
      } catch (err) {
        failures.push({
          appId: artifact.ownerId,
          path: artifact.absolutePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { middlewares, failures };
  }

  async run(
    turn: Parameters<TurnMiddleware["run"]>[0],
    modelReply: () => Promise<void>,
  ): Promise<void> {
    const chain = this.middlewares;
    if (chain.length === 0) {
      await modelReply();
      return;
    }
    // The input is shared, so a rewrite reaches the caller's model reply.
    const ctx: TurnMiddlewareContext = {
      input: turn.input,
      session: {
        id: turn.sessionId,
        agentName: turn.agentName,
        channelThreadKey: turn.continuityKey,
      },
      emit: (event) => turn.emit(event),
      meta: {},
    };

    const dispatch = async (i: number): Promise<void> => {
      if (i === chain.length) {
        await modelReply();
        return;
      }
      const mw = chain[i];
      let nextCalled = false;
      const next = async (): Promise<void> => {
        if (nextCalled) {
          throw new Error(`${HOOK_NAME} middleware (${mw.appId}) called next() more than once`);
        }
        nextCalled = true;
        await dispatch(i + 1);
      };
      try {
        await wrapHookSpan(
          HOOK_NAME,
          { "hook.app_id": mw.appId, "hook.order": mw.hook.order },
          () => mw.hook.handle(ctx, next),
        );
      } catch (err) {
        const mode = mw.hook.onError ?? "fail-open";
        if (mode === "fail-closed") {
          throw err;
        }
        // A broken middleware must never break the turn. Skip it and continue
        // inward, unless it already did.
        log.warn(`${HOOK_NAME} middleware threw; failing open`, {
          appId: mw.appId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!nextCalled) await next();
      }
    };

    await dispatch(0);
  }
}

function assertTurnMiddleware(
  hook: unknown,
  artifact: ArtifactRef,
): asserts hook is TurnMiddlewareHook {
  const mw = hook as TurnMiddlewareHook;
  if (typeof mw?.handle !== "function") {
    throw new Error(
      `Hook "${artifact.publicName}" from ${artifact.absolutePath} must implement handle(ctx, next)`,
    );
  }
  if (typeof mw.order !== "number") {
    throw new Error(
      `Hook "${artifact.publicName}" from ${artifact.absolutePath} must declare a numeric "order"`,
    );
  }
}

/** Lowest order runs furthest out. The sort is stable, so ties keep the order they were added in. */
function sortByOrder(middlewares: LoadedMiddleware[]): LoadedMiddleware[] {
  return [...middlewares].sort((a, b) => a.hook.order - b.hook.order);
}

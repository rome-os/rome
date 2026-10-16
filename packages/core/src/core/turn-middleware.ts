import type { TurnMiddlewareContext, TurnMiddlewareHook, TurnOutcome } from "@rome-os/app-runtime";
import type { ArtifactRef } from "../apps/state.js";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import {
  createMiddlewareChain,
  type Middleware,
  type MiddlewareChain,
  type MiddlewareLoadFailure,
  type MiddlewareTerminal,
} from "./middleware-chain.js";

/**
 * app-provided turn middleware live under the `turn-middleware` hook
 * publicName (a new hook *kind* on the existing hook artifact framework — same
 * app.yaml declaration, catalog discovery, and `createHook(deps)` factory as
 * the lifecycle hooks; only the dispatch semantics are new). The onion
 * mechanism itself is generic — see `middleware-chain.ts`; this module is just
 * its turn-shaped instantiation.
 */
export const TURN_MIDDLEWARE_HOOK_NAME = "turn-middleware";

export type TurnMiddlewareChain = MiddlewareChain<TurnMiddlewareContext, TurnOutcome>;
export type TurnMiddlewareLoadFailure = MiddlewareLoadFailure;
/** The innermost terminal layer of the onion: running the real model for this
 *  turn. Reached when every app middleware calls `next()`. */
export type TurnTerminal = MiddlewareTerminal;

export interface TurnMiddlewareChainOptions {
  appRuntimeServices?: RomeAppRuntimeServices;
}

export function createTurnMiddlewareChain(
  options: TurnMiddlewareChainOptions = {},
): TurnMiddlewareChain {
  return createMiddlewareChain<TurnMiddlewareContext, TurnOutcome>({
    hookName: TURN_MIDDLEWARE_HOOK_NAME,
    assert: assertTurnMiddleware,
    appRuntimeServices: options.appRuntimeServices,
  });
}

function assertTurnMiddleware(
  hook: unknown,
  artifact: ArtifactRef,
): asserts hook is Middleware<TurnMiddlewareContext, TurnOutcome> {
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

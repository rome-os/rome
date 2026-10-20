import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef } from "../apps/state.js";
import { createLogger } from "../logger.js";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import { wrapHookSpan } from "../telemetry.js";
import { loadAppHook } from "./hook-loader.js";

const log = createLogger("middleware-chain");

/**
 * What a middleware's next() returns: a thenable that records whether the
 * middleware attached a rejection handler to it (`await`, `catch`, or `then`
 * with `onRejected`), directly or further down a chain built from it, as in
 * `await next().finally(cleanup)` or `next().then(post).catch(recover)`. The
 * chain reports an inner failure as the middleware's own only when it never
 * did. A native promise can't record this, because `await` on one skips its
 * `then`, so every derived promise is one of these too.
 *
 * Each one's own rejection is marked handled. The chain surfaces the inner
 * failure itself, so a chain that never handles it, like `next().then(post)`,
 * can't carry it out as an unhandled rejection that exits the host.
 */
class ObservedResult<T> implements PromiseLike<T> {
  readonly [Symbol.toStringTag] = "Promise";

  constructor(
    private readonly promise: Promise<T>,
    readonly tracker: { observed: boolean } = { observed: false },
  ) {
    promise.catch(() => {});
  }

  get observed(): boolean {
    return this.tracker.observed;
  }

  then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    if (typeof onRejected === "function") this.tracker.observed = true;
    return this.derive(this.promise.then(onFulfilled, onRejected));
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.then(undefined, onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.derive(this.promise.finally(onFinally));
  }

  private derive<R>(derived: Promise<R>): Promise<R> {
    return new ObservedResult(derived, this.tracker) as unknown as Promise<R>;
  }
}

/**
 * The generic onion-middleware mechanism. A middleware kind is a code seam that
 * *wraps* a single operation with `next()` and a fixed innermost terminal — as
 * opposed to a fire-and-forget lifecycle hook (those stay in their own
 * dispatcher). Each kind instantiates one chain over its own context type:
 * `createMiddlewareChain<TurnMiddlewareContext>({ hookName, assert })`.
 *
 * The dispatch algorithm (ordered onion, `next()`-once guard, fail-open/closed,
 * telemetry) lives here once; the per-kind context shape and terminal stay with
 * the call site that owns them.
 */
export interface Middleware<Ctx, Outcome = void> {
  /** Explicit ordering, lowest runs furthest out. The terminal is always
   *  innermost regardless of declared order. */
  order: number;
  /** How the chain treats a throw: `fail-open` (default) skips the middleware
   *  and continues to `next()`; `fail-closed` aborts by rethrowing. */
  onError?: "fail-open" | "fail-closed";
  /** What it resolves with is ignored, so a passthrough can `return next()`. */
  handle(ctx: Ctx, next: () => Promise<Outcome>): Promise<unknown>;
}

interface LoadedMiddleware<Ctx, Outcome> {
  appId: string;
  artifactPath: string;
  hook: Middleware<Ctx, Outcome>;
}

export interface MiddlewareLoadFailure {
  appId: string;
  path: string;
  error: string;
}

/**
 * The innermost terminal layer of the onion: the real operation being wrapped
 * (e.g. running the model for a turn). Reached when every middleware calls
 * `next()`. A short-circuiting middleware never invokes it.
 */
export type MiddlewareTerminal = () => Promise<void>;

/** Reads what `next()` resolves with, once the layers inside have finished. */
export type OutcomeReader<Outcome> = () => Outcome | Promise<Outcome>;

/** `run`'s reader argument: required unless `next()` resolves with nothing. */
type OutcomeReaderArg<Outcome> = [Outcome] extends [void]
  ? []
  : [readOutcome: OutcomeReader<Outcome>];

export interface MiddlewareChain<Ctx, Outcome = void> {
  /** (Re)load all artifacts of this kind from the catalog. Returns any
   *  per-artifact load failures (a bad middleware is dropped, never fatal). */
  loadFromCatalog(catalog: AppCatalog): Promise<MiddlewareLoadFailure[]>;
  /** Execute the onion around `terminal`. With an empty chain this is exactly
   *  `await terminal()`. Resolves once every layer has finished, including
   *  layers a middleware started with an unawaited `next()`. Each
   *  middleware's `next()` resolves with `readOutcome()`, read once the layers
   *  inside it have finished. A chain
   *  whose `next()` resolves with nothing takes no reader. */
  run(ctx: Ctx, terminal: MiddlewareTerminal, ...outcome: OutcomeReaderArg<Outcome>): Promise<void>;
  /** Number of loaded middlewares (0 ⇒ pure passthrough). */
  size(): number;
}

export interface MiddlewareChainOptions<Ctx, Outcome = void> {
  /** The hook `publicName` that identifies this kind in the catalog. */
  hookName: string;
  /** Narrow a loaded hook to this kind's contract, throwing on mismatch. */
  assert(hook: unknown, artifact: ArtifactRef): asserts hook is Middleware<Ctx, Outcome>;
  appRuntimeServices?: RomeAppRuntimeServices;
}

export function createMiddlewareChain<Ctx, Outcome = void>(
  options: MiddlewareChainOptions<Ctx, Outcome>,
): MiddlewareChain<Ctx, Outcome> {
  const { hookName, appRuntimeServices } = options;
  let middlewares: LoadedMiddleware<Ctx, Outcome>[] = [];

  return {
    async loadFromCatalog(catalog) {
      const failures: MiddlewareLoadFailure[] = [];
      const next: LoadedMiddleware<Ctx, Outcome>[] = [];

      for (const artifact of catalog.listArtifacts("hook")) {
        if (artifact.publicName !== hookName) continue;
        try {
          const hook = await loadAppHook(artifact, catalog, appRuntimeServices);
          options.assert(hook, artifact);
          next.push({ appId: artifact.ownerId, artifactPath: artifact.absolutePath, hook });
        } catch (err) {
          failures.push({
            appId: artifact.ownerId,
            path: artifact.absolutePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Explicit order, lowest runs furthest out. Stable for ties so two
      // middlewares with the same order keep catalog order deterministically.
      next.sort((a, b) => a.hook.order - b.hook.order);
      middlewares = next;
      return failures;
    },

    async run(ctx, terminal, ...outcome) {
      // Absent only when Outcome is void, so next() then resolves with nothing.
      const readOutcome = (outcome as [OutcomeReader<Outcome>?])[0];
      const chain = middlewares;
      if (chain.length === 0) {
        await terminal();
        return;
      }

      const dispatch = async (i: number): Promise<void> => {
        if (i === chain.length) {
          await terminal();
          return;
        }
        const mw = chain[i];
        let nextCalled = false;
        let inner: Promise<void> | undefined;
        let result: ObservedResult<Outcome> | undefined;
        const next = (): Promise<Outcome> => {
          if (nextCalled) {
            return Promise.reject(
              new Error(`${hookName} middleware (${mw.appId}) called next() more than once`),
            );
          }
          nextCalled = true;
          const started = dispatch(i + 1);
          inner = started;
          result = new ObservedResult(started.then(async () => (await readOutcome?.()) as Outcome));
          return result as unknown as Promise<Outcome>;
        };
        try {
          await wrapHookSpan(
            hookName,
            { "hook.app_id": mw.appId, "hook.order": mw.hook.order },
            () => mw.hook.handle(ctx, next),
          );
          // A middleware's layer ends only once the layers its next() started
          // have ended, even when it didn't await next(). Their failure is its
          // own unless it attached a rejection handler to what next()
          // returned, as `try { await next() } catch` does.
          if (inner) {
            const failure = await inner.then(
              () => undefined,
              (err: unknown) => ({ err }),
            );
            if (failure && !result?.observed) throw failure.err;
          }
        } catch (err) {
          // Its error leaves this layer only once the layers it started have
          // ended, so no outer next() resolves while they still run.
          if (nextCalled) await inner?.catch(() => {});
          const mode = mw.hook.onError ?? "fail-open";
          if (mode === "fail-closed") {
            throw err;
          }
          // fail-open: a broken middleware must never break the wrapped
          // operation. Skip it and continue inward (unless it already advanced).
          log.warn(`${hookName} middleware threw; failing open`, {
            appId: mw.appId,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!nextCalled) await next();
        }
      };

      await dispatch(0);
    },

    size() {
      return middlewares.length;
    },
  };
}

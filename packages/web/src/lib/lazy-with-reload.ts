import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const RELOAD_STAMP_KEY = "rome.chunk-reload-at";
/** A second chunk failure inside this window shows the error screen instead of reloading again. */
const RELOAD_WINDOW_MS = 30_000;

/**
 * Whether an error is a failed fetch of a code-split chunk: the file is gone
 * after a deploy, or the network dropped. Covers the Rspack runtime's
 * `ChunkLoadError` and the native `import()` messages of Chrome, Firefox and
 * Safari.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return /Loading (CSS )?chunk [^\s]+ failed|dynamically imported module|Importing a module script failed/i.test(
    error.message,
  );
}

function reloadedRecently(): boolean {
  try {
    const stamp = Number(sessionStorage.getItem(RELOAD_STAMP_KEY));
    return Number.isFinite(stamp) && Date.now() - stamp < RELOAD_WINDOW_MS;
  } catch {
    return true;
  }
}

/**
 * Reloads the page unless it already reloaded for a chunk failure inside the
 * window. Returns whether a reload started, so the caller can fall back to an
 * error screen instead of looping. `reload` exists for tests: jsdom's
 * `location.reload` cannot be replaced.
 */
export function reloadForChunkFailure(
  reload: () => void = () => window.location.reload(),
): boolean {
  if (reloadedRecently()) return false;
  try {
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * `React.lazy` that recovers from a chunk the server no longer has. A stale tab
 * after a deploy asks for hashed files that are gone, and the fresh `index.html`
 * names the new ones, so one reload fixes it. The reload happens once per
 * window; a repeat failure rethrows to the nearest `ChunkErrorBoundary`.
 */
// biome-ignore lint/suspicious/noExplicitAny: the same bound React.lazy declares, so props are inferred from the module
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      if (!isChunkLoadError(error) || !reloadForChunkFailure()) throw error;
      // The page is unloading; keep Suspense pending instead of flashing the error screen.
      return new Promise<never>(() => {});
    }),
  );
}

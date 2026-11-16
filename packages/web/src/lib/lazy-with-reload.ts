import { lazy as reactLazy } from "react";

/**
 * Session-storage key holding the URL last reloaded for a missing chunk and
 * when, so a chunk that is still missing after the reload does not loop.
 */
export const CHUNK_RELOAD_KEY = "rome-chunk-reload";
/** A second failure on the same URL within this window is not reloaded again. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;
const SERVER_WAIT_MS = 3_000;

/**
 * Whether `error` is a failed load of a code-split chunk: the bundler's own
 * error, or the browser's for a native dynamic import.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return /Loading (CSS )?chunk [^ ]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message,
  );
}

/**
 * Claims the one reload for the current URL. False when it was already
 * reloaded for a missing chunk within CHUNK_RELOAD_WINDOW_MS.
 */
function claimReload(): boolean {
  const url = window.location.href;
  const now = Date.now();
  try {
    const last = JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "null") as {
      url?: string;
      at?: number;
    } | null;
    if (
      last?.url === url &&
      typeof last.at === "number" &&
      now - last.at < CHUNK_RELOAD_WINDOW_MS
    ) {
      return false;
    }
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ url, at: now }));
    return true;
  } catch {
    // Storage blocked: without a record a reload could loop, so do not.
    return false;
  }
}

async function serverAnswers(): Promise<boolean> {
  try {
    const res = await fetch("/api/build-info", {
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(SERVER_WAIT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Loads a code-split module, and when its chunk is missing, loads the page
 * again. An upgrade replaces the frontend's hashed chunks, so a page still on
 * the old bundle cannot load a part it has not loaded yet; a full load of
 * the same URL gets the new bundle. While the server does not answer (it is
 * restarting) the load is tried again until it does, rather than reloading
 * into an error page. A chunk still missing after one reload fails as usual.
 */
export async function loadWithReload<T>(load: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await load();
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;
      if (!(await serverAnswers())) {
        await new Promise((resolve) => setTimeout(resolve, SERVER_WAIT_MS));
        continue;
      }
      if (!claimReload()) throw error;
      window.location.reload();
      // The page is going away; never settle, so nothing renders an error first.
      return new Promise<T>(() => {});
    }
  }
}

/** `React.lazy`, with a missing chunk handled by `loadWithReload`. */
export const lazy: typeof reactLazy = (load) => reactLazy(() => loadWithReload(load));

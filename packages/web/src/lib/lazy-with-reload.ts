import { lazy as reactLazy } from "react";

/**
 * Session-storage key holding the URL and the part last reloaded for a
 * missing chunk, so a part still missing after the reload does not loop.
 */
export const CHUNK_RELOAD_KEY = "rome-chunk-reload";
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

interface ReloadMark {
  url: string;
  part: string;
}

function readMark(): ReloadMark | null {
  return JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "null") as ReloadMark | null;
}

/**
 * Claims the one reload for `part` at the current URL. False when this part
 * already reloaded this URL and has not loaded since: the reload did not
 * bring it back, so another would only repeat. No time limit, since a chunk
 * can take minutes to fail.
 */
function claimReload(part: string): boolean {
  const url = window.location.href;
  try {
    const mark = readMark();
    if (mark?.url === url && mark.part === part) return false;
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, JSON.stringify({ url, part }));
    return true;
  } catch {
    // Storage blocked: without a record a reload could loop, so do not.
    return false;
  }
}

/** `part` loaded: a later upgrade may reload for it again. */
function clearMark(part: string): void {
  try {
    if (readMark()?.part === part) window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // Storage blocked: nothing was recorded.
  }
}

/**
 * Whether the server answers at all. The health route needs no session, so
 * a signed-out page gets an answer too; anything below 500 is the server
 * itself answering, and a 5xx or no answer is the edge with no server
 * behind it.
 */
async function serverAnswers(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", {
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(SERVER_WAIT_MS),
    });
    return res.status < 500;
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
  // The loader's source names its module, also when minified, so it tells
  // the parts of one page apart.
  const part = String(load);
  for (;;) {
    try {
      const loaded = await load();
      clearMark(part);
      return loaded;
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;
      if (!(await serverAnswers())) {
        await new Promise((resolve) => setTimeout(resolve, SERVER_WAIT_MS));
        continue;
      }
      if (!claimReload(part)) throw error;
      window.location.reload();
      // The page is going away; never settle, so nothing renders an error first.
      return new Promise<T>(() => {});
    }
  }
}

/** `React.lazy`, with a missing chunk handled by `loadWithReload`. */
export const lazy: typeof reactLazy = (load) => reactLazy(() => loadWithReload(load));

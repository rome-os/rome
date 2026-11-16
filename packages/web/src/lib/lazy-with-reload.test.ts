// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { CHUNK_RELOAD_KEY, isChunkLoadError, loadWithReload } from "./lazy-with-reload";

function chunkError(): Error {
  const error = new Error("Loading chunk 812 failed.\n(missing: http://x/static/js/async/812.js)");
  error.name = "ChunkLoadError";
  return error;
}

let reload: ReturnType<typeof rs.fn>;
let serverUp: boolean;

beforeEach(() => {
  window.sessionStorage.clear();
  reload = rs.fn();
  rs.stubGlobal("location", { ...window.location, href: "http://x/people", reload });
  serverUp = true;
  rs.spyOn(globalThis, "fetch").mockImplementation((async () => {
    if (!serverUp) throw new TypeError("Failed to fetch");
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
});

afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  rs.useRealTimers();
});

describe("isChunkLoadError", () => {
  it("knows the bundler's and the browsers' chunk failures, and nothing else", () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk 12 failed.\n(/static/css/12.css)"))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: x"))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("Loading chunk 1 failed")).toBe(false);
  });
});

describe("loadWithReload", () => {
  it("returns the module when it loads", async () => {
    await expect(loadWithReload(async () => ({ default: 1 }))).resolves.toEqual({ default: 1 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("loads the page again when a chunk is missing", async () => {
    void loadWithReload(() => Promise.reject(chunkError()));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "{}").url).toBe(
      "http://x/people",
    );
  });

  it("fails instead of reloading the same URL a second time", async () => {
    void loadWithReload(() => Promise.reject(chunkError()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The reloaded page hits the same missing chunk.
    await expect(loadWithReload(() => Promise.reject(chunkError()))).rejects.toThrow(
      "Loading chunk 812 failed",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads another URL even after one was reloaded", async () => {
    void loadWithReload(() => Promise.reject(chunkError()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rs.stubGlobal("location", { ...window.location, href: "http://x/memory", reload });

    void loadWithReload(() => Promise.reject(chunkError()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("passes other errors through", async () => {
    await expect(loadWithReload(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits for a restarting server and loads the chunk once it answers", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    serverUp = false;
    let attempts = 0;
    const loaded = loadWithReload(async () => {
      attempts += 1;
      if (attempts < 2) throw chunkError();
      return { default: "page" };
    });

    await rs.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    serverUp = true;
    await rs.advanceTimersByTimeAsync(3_000);

    await expect(loaded).resolves.toEqual({ default: "page" });
    expect(reload).not.toHaveBeenCalled();
  });
});

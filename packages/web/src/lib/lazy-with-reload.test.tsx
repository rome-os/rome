// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { render, screen } from "@testing-library/react";
import { type ComponentType, Suspense } from "react";
import {
  CHUNK_RELOAD_KEY,
  isChunkLoadError,
  lazyInPlace,
  loadWithReload,
} from "./lazy-with-reload";

function chunkError(): Error {
  const error = new Error("Loading chunk 812 failed.\n(missing: http://x/static/js/async/812.js)");
  error.name = "ChunkLoadError";
  return error;
}

let reload: ReturnType<typeof rs.fn>;
let serverUp: boolean;
let healthStatus: number;

beforeEach(() => {
  window.sessionStorage.clear();
  reload = rs.fn();
  rs.stubGlobal("location", { ...window.location, href: "http://x/people", reload });
  serverUp = true;
  healthStatus = 200;
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/health") throw new Error(`unexpected request: ${String(input)}`);
    if (!serverUp) throw new TypeError("Failed to fetch");
    return new Response("{}", { status: healthStatus });
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
    expect(
      Object.keys(JSON.parse(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "{}")),
    ).toEqual(["http://x/people"]);
  });

  it("reloads on a signed-out page, where the server answers 401", async () => {
    healthStatus = 401;
    void loadWithReload(() => Promise.reject(chunkError()));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("waits while the edge answers 502 for a server that is not back", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    healthStatus = 502;
    void loadWithReload(() => Promise.reject(chunkError()));

    await rs.advanceTimersByTimeAsync(10_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload again for a part that failed slowly after its reload", async () => {
    void loadWithReload(() => Promise.reject(chunkError()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A chunk can take minutes to time out; the guard has no clock.
    const realNow = Date.now.bind(Date);
    rs.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60_000);
    await expect(loadWithReload(() => Promise.reject(chunkError()))).rejects.toThrow(
      "Loading chunk 812 failed",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again for a later upgrade once the part has loaded", async () => {
    let missing = true;
    const load = async () => {
      if (missing) throw chunkError();
      return { default: "page" };
    };
    void loadWithReload(load);
    await new Promise((resolve) => setTimeout(resolve, 0));
    missing = false;
    await expect(loadWithReload(load)).resolves.toEqual({ default: "page" });
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();

    missing = true;
    void loadWithReload(load);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reloads once more for a different part of the same page", async () => {
    void loadWithReload(() => Promise.reject(chunkError()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    void loadWithReload(async () => {
      throw chunkError();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not loop when two parts stay missing side by side", async () => {
    const partA = () => Promise.reject(chunkError());
    const partB = async () => {
      throw chunkError();
    };
    // The first load: both parts fail together, and each claims its reload.
    void loadWithReload(partA);
    void loadWithReload(partB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(2);

    // The reloaded page: both still missing, in either order.
    await expect(loadWithReload(partB)).rejects.toThrow("Loading chunk 812 failed");
    await expect(loadWithReload(partA)).rejects.toThrow("Loading chunk 812 failed");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not loop when a page and a frame at another URL both stay missing", async () => {
    // The top page and an app tile's frame share session storage.
    const at = (href: string) => rs.stubGlobal("location", { ...window.location, href, reload });
    const part = () => Promise.reject(chunkError());

    at("http://x/people");
    void loadWithReload(part);
    await new Promise((resolve) => setTimeout(resolve, 0));
    at("http://x/full/apps/notes");
    void loadWithReload(part);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reload).toHaveBeenCalledTimes(2);

    // Both reloaded documents miss the part again, one after the other.
    at("http://x/people");
    await expect(loadWithReload(part)).rejects.toThrow("Loading chunk 812 failed");
    at("http://x/full/apps/notes");
    await expect(loadWithReload(part)).rejects.toThrow("Loading chunk 812 failed");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("leaves another URL's guard alone when a part loads", async () => {
    const at = (href: string) => rs.stubGlobal("location", { ...window.location, href, reload });
    let missing = true;
    const part = async () => {
      if (missing) throw chunkError();
      return { default: "page" };
    };

    at("http://x/people");
    void loadWithReload(part);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The same part loads in a frame at another URL.
    at("http://x/full/apps/notes");
    missing = false;
    await loadWithReload(part);

    // The page, still missing it, does not reload a second time.
    at("http://x/people");
    missing = true;
    await expect(loadWithReload(part)).rejects.toThrow("Loading chunk 812 failed");
    expect(reload).toHaveBeenCalledTimes(1);
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

describe("lazyInPlace", () => {
  function Missing() {
    return <p>needs reload</p>;
  }

  it("shows the stand-in for a missing chunk and never reloads", async () => {
    const Preview = lazyInPlace(Missing)<ComponentType<{ title: string }>>(() =>
      Promise.reject(chunkError()),
    );
    render(
      <Suspense fallback={null}>
        <Preview title="x" />
      </Suspense>,
    );

    expect(await screen.findByText("needs reload")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("renders the module when it loads", async () => {
    const Preview = lazyInPlace(Missing)(async () => ({
      default: ({ title }: { title: string }) => <p>{title}</p>,
    }));
    render(
      <Suspense fallback={null}>
        <Preview title="loaded" />
      </Suspense>,
    );

    expect(await screen.findByText("loaded")).toBeTruthy();
  });
});

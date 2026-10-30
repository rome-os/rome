// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { isChunkLoadError, reloadForChunkFailure } from "./lazy-with-reload";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  rs.useRealTimers();
});

describe("isChunkLoadError", () => {
  it("recognises the Rspack runtime error and the browsers' own import failures", () => {
    const rspack = new Error("Loading chunk 2056 failed.");
    rspack.name = "ChunkLoadError";
    expect(isChunkLoadError(rspack)).toBe(true);
    expect(
      isChunkLoadError(new Error("Loading chunk 12 failed. (missing: /static/js/12.js)")),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /a.js")),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("error loading dynamically imported module: /a.js")),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError("Loading chunk 1 failed")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("reloadForChunkFailure", () => {
  it("reloads once, then refuses inside the window so a broken deploy cannot loop", () => {
    const reload = rs.fn();
    expect(reloadForChunkFailure(reload)).toBe(true);
    expect(reloadForChunkFailure(reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the window has passed", () => {
    rs.useFakeTimers();
    const reload = rs.fn();
    expect(reloadForChunkFailure(reload)).toBe(true);
    rs.advanceTimersByTime(31_000);
    expect(reloadForChunkFailure(reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the guard cannot be stored", () => {
    const reload = rs.fn();
    const setItem = rs.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(reloadForChunkFailure(reload)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });
});

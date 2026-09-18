// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  APP_LAST_OPENED_STORAGE_KEY,
  useAppLastOpened,
  useRecordAppOpened,
} from "./use-recent-apps";

function stored(): Record<string, string> {
  return JSON.parse(localStorage.getItem(APP_LAST_OPENED_STORAGE_KEY) ?? "{}");
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useRecordAppOpened", () => {
  it("records the open in this browser for a guardian", () => {
    renderHook(() => useRecordAppOpened("recipe-box", true));

    const written = stored();
    expect(Object.keys(written)).toEqual(["recipe-box"]);
    expect(Number.isNaN(Date.parse(written["recipe-box"]))).toBe(false);
  });

  it("does nothing when disabled or without an app id", () => {
    renderHook(() => useRecordAppOpened("recipe-box", false));
    renderHook(() => useRecordAppOpened(undefined, true));

    expect(localStorage.getItem(APP_LAST_OPENED_STORAGE_KEY)).toBeNull();
  });

  it("keeps other apps' entries and drops ones older than the window", () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      APP_LAST_OPENED_STORAGE_KEY,
      JSON.stringify({ "other-app": fresh, "old-app": stale }),
    );

    renderHook(() => useRecordAppOpened("recipe-box", true));

    const written = stored();
    expect(written["other-app"]).toBe(fresh);
    expect(written["recipe-box"]).toBeDefined();
    expect(written["old-app"]).toBeUndefined();
  });

  it("reopening an app moves its timestamp forward (A, B, A puts A newest)", () => {
    const earlier = new Date(Date.now() - 10 * 60_000).toISOString();
    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: earlier, b: earlier }));

    renderHook(() => useRecordAppOpened("a", true));

    const written = stored();
    expect(Date.parse(written.a)).toBeGreaterThan(Date.parse(written.b));
  });
});

describe("useAppLastOpened", () => {
  it("reads what this browser has recorded", () => {
    const opened = new Date().toISOString();
    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: opened }));

    const { result } = renderHook(() => useAppLastOpened());

    expect(result.current).toEqual({ a: opened });
  });

  it("re-reads when another part of the page records an open", async () => {
    const { result } = renderHook(() => useAppLastOpened());
    const opened = new Date().toISOString();

    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: opened }));
    window.dispatchEvent(new Event("rome-app-opened"));

    await waitFor(() => expect(result.current).toEqual({ a: opened }));
  });

  it("re-reads when another tab records an open", async () => {
    const { result } = renderHook(() => useAppLastOpened());
    const opened = new Date().toISOString();

    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: opened }));
    window.dispatchEvent(new StorageEvent("storage", { key: APP_LAST_OPENED_STORAGE_KEY }));

    await waitFor(() => expect(result.current).toEqual({ a: opened }));
  });

  it("ignores storage events for other keys", async () => {
    const { result } = renderHook(() => useAppLastOpened());
    const opened = new Date().toISOString();

    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: opened }));
    window.dispatchEvent(new StorageEvent("storage", { key: "rome-sidebar-pins" }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({});
  });
});

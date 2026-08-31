// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { act, renderHook } from "@testing-library/react";
import {
  PRESENTATION_MODE_STORAGE_KEY,
  isPresentationMode,
  setPresentationMode,
  usePresentationMode,
} from "./presentation-mode";

afterEach(() => {
  window.localStorage.clear();
});

describe("presentation-mode", () => {
  it("is off by default and round-trips through the setter", () => {
    expect(isPresentationMode()).toBe(false);

    setPresentationMode(true);
    expect(isPresentationMode()).toBe(true);
    expect(window.localStorage.getItem(PRESENTATION_MODE_STORAGE_KEY)).toBe("1");

    // Off removes the key entirely so the default path stays the empty store.
    setPresentationMode(false);
    expect(isPresentationMode()).toBe(false);
    expect(window.localStorage.getItem(PRESENTATION_MODE_STORAGE_KEY)).toBeNull();
  });

  it("usePresentationMode re-renders subscribers on same-tab toggles", () => {
    const { result } = renderHook(() => usePresentationMode());
    expect(result.current).toBe(false);

    act(() => setPresentationMode(true));
    expect(result.current).toBe(true);

    act(() => setPresentationMode(false));
    expect(result.current).toBe(false);
  });

  it("usePresentationMode reflects cross-tab storage events", () => {
    const { result } = renderHook(() => usePresentationMode());

    // A write from another tab arrives as a `storage` event, not our custom one.
    act(() => {
      window.localStorage.setItem(PRESENTATION_MODE_STORAGE_KEY, "1");
      window.dispatchEvent(new StorageEvent("storage", { key: PRESENTATION_MODE_STORAGE_KEY }));
    });
    expect(result.current).toBe(true);
  });
});

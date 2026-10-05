// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { deriveTabStatus, topTabStatus, useFinishedUnseen } from "./use-tab-status";

describe("deriveTabStatus", () => {
  it("puts a waiting card ahead of a running reply", () => {
    expect(
      deriveTabStatus({ streaming: true, awaitingGuardian: true, finishedUnseen: false }),
    ).toBe("needs-you");
  });

  it("shows a running reply over an earlier unseen finish", () => {
    expect(
      deriveTabStatus({ streaming: true, awaitingGuardian: false, finishedUnseen: true }),
    ).toBe("working");
  });

  it("is idle when nothing is pending", () => {
    expect(
      deriveTabStatus({ streaming: false, awaitingGuardian: false, finishedUnseen: false }),
    ).toBe("idle");
  });
});

describe("topTabStatus", () => {
  it("lets the chat that most needs the guardian win", () => {
    expect(topTabStatus(["done", "needs-you", "working"])).toBe("needs-you");
    expect(topTabStatus(["idle", "done"])).toBe("done");
    expect(topTabStatus([])).toBe("idle");
  });
});

describe("useFinishedUnseen", () => {
  let hidden = false;
  let focused = true;

  beforeEach(() => {
    hidden = false;
    focused = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.hasFocus = () => focused;
  });

  afterEach(cleanup);

  it("stays false when the reply ends while the guardian is watching", () => {
    const { result, rerender } = renderHook(({ streaming }) => useFinishedUnseen(streaming), {
      initialProps: { streaming: true },
    });
    rerender({ streaming: false });
    expect(result.current).toBe(false);
  });

  it("marks a reply that ends in a hidden tab, and clears when the tab is shown", () => {
    const { result, rerender } = renderHook(({ streaming }) => useFinishedUnseen(streaming), {
      initialProps: { streaming: true },
    });
    hidden = true;
    rerender({ streaming: false });
    expect(result.current).toBe(true);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(false);
  });

  it("treats an unfocused window as away, and clears on focus", () => {
    const { result, rerender } = renderHook(({ streaming }) => useFinishedUnseen(streaming), {
      initialProps: { streaming: true },
    });
    focused = false;
    rerender({ streaming: false });
    expect(result.current).toBe(true);

    focused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe(false);
  });
});

// @rstest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { startUserActivityReporting } from "./user-activity";

describe("foreground user activity", () => {
  const fetchMock = rs.fn<typeof fetch>();
  let stop: (() => void) | undefined;
  let visible = true;
  let focused = true;
  let listeners: Map<string, EventListener>;

  beforeEach(() => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    visible = true;
    focused = true;
    listeners = new Map();
    rs.spyOn(document, "hasFocus").mockImplementation(() => focused);
    rs.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      visible ? "visible" : "hidden",
    );
    const addListener = document.addEventListener.bind(document);
    rs.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      listeners.set(type, listener as EventListener);
      addListener(type, listener, options);
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    rs.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    rs.restoreAllMocks();
    rs.unstubAllGlobals();
    rs.useRealTimers();
  });

  function interact(type = "pointerdown", isTrusted = true) {
    listeners.get(type)?.({ isTrusted } as Event);
  }

  it("records foreground opening and interactions, but never polls an idle tab", () => {
    stop = startUserActivityReporting();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/user-activity");
    expect(init?.credentials).toBe("include");
    expect(init?.body).toBeUndefined();
    interact();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rs.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    interact("keydown");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores background, unfocused, and synthetic activity", () => {
    visible = false;
    stop = startUserActivityReporting();
    interact();
    expect(fetchMock).not.toHaveBeenCalled();
    visible = true;
    focused = false;
    interact("visibilitychange");
    expect(fetchMock).not.toHaveBeenCalled();
    focused = true;
    interact("pointerdown", false);
    expect(fetchMock).not.toHaveBeenCalled();
    interact("wheel");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes all listeners on logout or unmount", () => {
    const removeDocument = rs.spyOn(document, "removeEventListener");
    const removeWindow = rs.spyOn(window, "removeEventListener");
    startUserActivityReporting()();
    expect(removeDocument.mock.calls.map(([type]) => type)).toEqual([
      "pointerdown",
      "keydown",
      "wheel",
      "visibilitychange",
    ]);
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
  });
});

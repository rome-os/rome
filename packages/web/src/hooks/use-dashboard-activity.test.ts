// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { inPhoneAppWebView, watchDashboardActivity } from "./use-dashboard-activity";

describe("watchDashboardActivity", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    rs.restoreAllMocks();
  });

  function watch(state: { visible: boolean; focused: boolean }) {
    rs.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      state.visible ? "visible" : "hidden",
    );
    rs.spyOn(document, "hasFocus").mockImplementation(() => state.focused);
    const reportActivity = rs.fn();
    stops.push(watchDashboardActivity({ reportActivity, hold: () => () => {} }));
    return reportActivity;
  }

  it("reports active on keyboard, pointer or touch input while the tab is visible and focused", () => {
    const report = watch({ visible: true, focused: true });
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("touchstart"));
    expect(report.mock.calls).toEqual([["active"], ["active"], ["active"]]);
  });

  it("reports nothing on input while the window is not focused or the tab is hidden", () => {
    const state = { visible: true, focused: false };
    const report = watch(state);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    state.focused = true;
    state.visible = false;
    window.dispatchEvent(new Event("pointermove"));
    expect(report).not.toHaveBeenCalled();
  });

  it("reports away when the tab is hidden, the window loses focus, or the page closes", async () => {
    const state = { visible: true, focused: true };
    const report = watch(state);
    state.focused = false;
    window.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event("pagehide"));
    state.visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(report.mock.calls).toEqual([["away"], ["away"], ["away"]]);
  });

  it("stays active when focus moves into an embedded app's iframe", async () => {
    const report = watch({ visible: true, focused: true });
    // The window blurs, but the document still has focus.
    window.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(report).not.toHaveBeenCalled();
  });

  it("holds the live-events socket open while it watches, and lets go when stopped", () => {
    const release = rs.fn();
    const hold = rs.fn(() => release);
    const stop = watchDashboardActivity({ reportActivity: rs.fn(), hold });
    expect(hold).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    stop();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports nothing inside the phone app's web view", () => {
    rs.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 RomeiOS/1.4.0",
    );
    const report = watch({ visible: true, focused: true });
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new Event("touchstart"));
    window.dispatchEvent(new Event("pagehide"));
    expect(report).not.toHaveBeenCalled();
  });

  it("reports activity in a browser whose user agent only resembles the app's", () => {
    rs.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 NotRomeiOS/1.0");
    const report = watch({ visible: true, focused: true });
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(report).toHaveBeenCalledWith("active");
  });

  it("counts continued input inside a same-origin app iframe, added before or after it starts", async () => {
    const before = document.createElement("iframe");
    document.body.append(before);
    const report = watch({ visible: true, focused: true });
    const after = document.createElement("iframe");
    document.body.append(after);
    // The observer sees the new frame once the mutation is delivered.
    await new Promise((resolve) => setTimeout(resolve, 0));
    before.contentWindow?.dispatchEvent(new KeyboardEvent("keydown"));
    after.contentWindow?.dispatchEvent(new Event("pointerdown"));
    // Input keeps arriving from the frame, as it would past the active window.
    before.contentWindow?.dispatchEvent(new Event("pointermove"));
    expect(report.mock.calls).toEqual([["active"], ["active"], ["active"]]);
    before.remove();
    after.remove();
  });

  it("lets go of a frame taken out of the page", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const report = watch({ visible: true, focused: true });
    const frameWindow = frame.contentWindow;
    const removeListener = rs.spyOn(frameWindow as Window, "removeEventListener");
    frame.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function), expect.anything());
    frameWindow?.dispatchEvent(new KeyboardEvent("keydown"));
    expect(report).not.toHaveBeenCalled();
  });

  it("listens to a frame's new window after it loads again", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const report = watch({ visible: true, focused: true });
    frame.dispatchEvent(new Event("load"));
    frame.contentWindow?.dispatchEvent(new KeyboardEvent("keydown"));
    // Listening again after a load never doubles the count.
    expect(report.mock.calls).toEqual([["active"]]);
    frame.remove();
  });

  it("stops reporting once stopped", () => {
    const report = watch({ visible: true, focused: true });
    stops.splice(0).forEach((stop) => stop());
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new Event("blur"));
    expect(report).not.toHaveBeenCalled();
  });
});

describe("inPhoneAppWebView", () => {
  it("knows the phone app's web view by its marker, and an older build's by a missing Safari token", () => {
    // A build with the marker.
    expect(
      inPhoneAppWebView(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 RomeiOS/1.4.0",
      ),
    ).toBe(true);
    // An installed build from before it: a bare WKWebView on iPhone and iPad.
    expect(
      inPhoneAppWebView(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ),
    ).toBe(true);
    expect(
      inPhoneAppWebView(
        "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ),
    ).toBe(true);
  });

  it("leaves Safari, other iOS browsers and desktop browsers counting", () => {
    for (const userAgent of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ]) {
      expect(inPhoneAppWebView(userAgent)).toBe(false);
    }
  });
});

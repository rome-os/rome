// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { watchDashboardActivity } from "./use-dashboard-activity";

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
    stops.push(watchDashboardActivity({ reportActivity }));
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

  it("reports away at once when the tab is hidden, the window loses focus, or the page closes", () => {
    const state = { visible: true, focused: true };
    const report = watch(state);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pagehide"));
    state.visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(report.mock.calls).toEqual([["away"], ["away"], ["away"]]);
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

  it("stops reporting once stopped", () => {
    const report = watch({ visible: true, focused: true });
    stops.splice(0).forEach((stop) => stop());
    window.dispatchEvent(new KeyboardEvent("keydown"));
    window.dispatchEvent(new Event("blur"));
    expect(report).not.toHaveBeenCalled();
  });
});

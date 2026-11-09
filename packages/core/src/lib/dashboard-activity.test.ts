import { describe, expect, it } from "@rstest/core";
import { DASHBOARD_ACTIVE_MS, DashboardActivity } from "./dashboard-activity.js";

function activityAt() {
  let now = 1_000_000;
  const activity = new DashboardActivity(() => now);
  return {
    activity,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("DashboardActivity", () => {
  it("counts a dashboard as active only from its first active signal", () => {
    const { activity } = activityAt();
    const socket = activity.open();
    expect(activity.isActive()).toBe(false);
    socket.active();
    expect(activity.isActive()).toBe(true);
  });

  it("counts a dashboard for one minute after its last active signal", () => {
    expect(DASHBOARD_ACTIVE_MS).toBe(60_000);
    const { activity, advance } = activityAt();
    const socket = activity.open();
    socket.active();
    advance(DASHBOARD_ACTIVE_MS - 1);
    expect(activity.isActive()).toBe(true);
    socket.active();
    advance(DASHBOARD_ACTIVE_MS - 1);
    expect(activity.isActive()).toBe(true);
    advance(1);
    expect(activity.isActive()).toBe(false);
  });

  it("stops counting a dashboard at once when it says away, until it is active again", () => {
    const { activity } = activityAt();
    const socket = activity.open();
    socket.active();
    socket.away();
    expect(activity.isActive()).toBe(false);
    socket.active();
    expect(activity.isActive()).toBe(true);
  });

  it("stops counting a closed socket at once, and for good", () => {
    const { activity } = activityAt();
    const socket = activity.open();
    socket.active();
    socket.close();
    expect(activity.isActive()).toBe(false);
    socket.active();
    expect(activity.isActive()).toBe(false);
  });

  it("is active while any one dashboard is", () => {
    const { activity, advance } = activityAt();
    const laptop = activity.open();
    const desktop = activity.open();
    laptop.active();
    advance(DASHBOARD_ACTIVE_MS / 2);
    desktop.active();
    laptop.away();
    expect(activity.isActive()).toBe(true);
    desktop.close();
    expect(activity.isActive()).toBe(false);
  });
});

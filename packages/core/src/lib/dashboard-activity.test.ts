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
    const socket = activity.open("guardian");
    expect(activity.isActive("guardian")).toBe(false);
    socket.active();
    expect(activity.isActive("guardian")).toBe(true);
  });

  it("counts a dashboard for one minute after its last active signal", () => {
    expect(DASHBOARD_ACTIVE_MS).toBe(60_000);
    const { activity, advance } = activityAt();
    const socket = activity.open("guardian");
    socket.active();
    advance(DASHBOARD_ACTIVE_MS - 1);
    expect(activity.isActive("guardian")).toBe(true);
    socket.active();
    advance(DASHBOARD_ACTIVE_MS - 1);
    expect(activity.isActive("guardian")).toBe(true);
    advance(1);
    expect(activity.isActive("guardian")).toBe(false);
  });

  it("stops counting a dashboard at once when it says away, until it is active again", () => {
    const { activity } = activityAt();
    const socket = activity.open("guardian");
    socket.active();
    socket.away();
    expect(activity.isActive("guardian")).toBe(false);
    socket.active();
    expect(activity.isActive("guardian")).toBe(true);
  });

  it("stops counting a closed socket at once, and for good", () => {
    const { activity } = activityAt();
    const socket = activity.open("guardian");
    socket.active();
    socket.close();
    expect(activity.isActive("guardian")).toBe(false);
    socket.active();
    expect(activity.isActive("guardian")).toBe(false);
  });

  it("is active while any one dashboard is", () => {
    const { activity, advance } = activityAt();
    const laptop = activity.open("guardian");
    const desktop = activity.open("guardian");
    laptop.active();
    advance(DASHBOARD_ACTIVE_MS / 2);
    desktop.active();
    laptop.away();
    expect(activity.isActive("guardian")).toBe(true);
    desktop.close();
    expect(activity.isActive("guardian")).toBe(false);
  });

  it("counts a dashboard only for the person signed in on it", () => {
    const { activity } = activityAt();
    activity.open("visitor:acct-1").active();
    expect(activity.isActive("visitor:acct-1")).toBe(true);
    expect(activity.isActive("guardian")).toBe(false);
    expect(activity.isActive("visitor:acct-2")).toBe(false);
  });
});

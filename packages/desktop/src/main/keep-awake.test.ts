import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { DISCONNECTED_GRACE_MS, KeepAwake } from "./keep-awake";

function blocker() {
  let next = 1;
  return { start: rs.fn(() => next++), stop: rs.fn((_id: number) => true) };
}

const device = { deviceId: "d1", name: "MacBook" };
const connected = { state: "connected", ...device } as const;
const connecting = { state: "connecting", ...device } as const;
const offline = { state: "offline", ...device } as const;

beforeEach(() => {
  rs.useFakeTimers();
});

afterEach(() => {
  rs.useRealTimers();
});

describe("KeepAwake", () => {
  it("holds one display blocker while the device connects and stays connected", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync(connecting);
    awake.sync(connected);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS * 2);
    expect(power.start).toHaveBeenCalledTimes(1);
    expect(power.start).toHaveBeenCalledWith("prevent-display-sleep");
    expect(power.stop).not.toHaveBeenCalled();
  });

  it("keeps the hold through an outage shorter than the grace period", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync(connected);
    awake.sync(offline);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS - 1);
    awake.sync(connected);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    expect(power.start).toHaveBeenCalledTimes(1);
    expect(power.stop).not.toHaveBeenCalled();
  });

  it("releases after the grace period even while it keeps retrying", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync(connected);
    awake.sync(offline);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS / 2);
    awake.sync(connecting);
    awake.sync(offline);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS / 2);
    expect(power.stop).toHaveBeenCalledWith(1);
    awake.sync(connecting);
    awake.sync(offline);
    expect(power.start).toHaveBeenCalledTimes(1);
  });

  it("takes the hold again when the device reconnects after the grace period", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync(offline);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    awake.sync(connected);
    expect(power.start).toHaveBeenCalledTimes(2);
  });

  it("releases at once when the device is turned off or the app signs out", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync(connected);
    awake.sync({ state: "disabled", ...device });
    expect(power.stop).toHaveBeenCalledWith(1);
    awake.sync(connected);
    awake.sync({ state: "off" });
    expect(power.stop).toHaveBeenLastCalledWith(2);
    rs.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    expect(power.stop).toHaveBeenCalledTimes(2);
  });

  it("does not start a blocker for a device that is off", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync({ state: "off" });
    awake.sync({ state: "disabled", ...device });
    awake.release();
    expect(power.start).not.toHaveBeenCalled();
    expect(power.stop).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, rs } from "@rstest/core";
import { KeepAwake } from "./keep-awake";

function blocker() {
  let next = 1;
  return { start: rs.fn(() => next++), stop: rs.fn((_id: number) => true) };
}

const device = { deviceId: "d1", name: "MacBook" };

describe("KeepAwake", () => {
  it("holds one blocker while the device is on", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync({ state: "connecting", ...device });
    awake.sync({ state: "connected", ...device });
    awake.sync({ state: "offline", ...device });
    expect(power.start).toHaveBeenCalledTimes(1);
    expect(power.start).toHaveBeenCalledWith("prevent-display-sleep");
    expect(power.stop).not.toHaveBeenCalled();
  });

  it("releases when the device is turned off or signed out", () => {
    const power = blocker();
    const awake = new KeepAwake(power);
    awake.sync({ state: "connected", ...device });
    awake.sync({ state: "disabled", ...device });
    expect(power.stop).toHaveBeenCalledWith(1);
    awake.sync({ state: "connecting", ...device });
    awake.sync({ state: "off" });
    expect(power.stop).toHaveBeenLastCalledWith(2);
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

// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { chooseMicrophone, chosenMicrophone, listMicrophones } from "./microphone-choice";

function devices(list: Array<Partial<MediaDeviceInfo>>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: rs.fn(async () => list) },
  });
}

afterEach(() => {
  localStorage.clear();
});

describe("the chosen microphone", () => {
  it("is the system default until one is chosen, and again after it is cleared", () => {
    expect(chosenMicrophone()).toBeNull();
    chooseMicrophone("usb-mic");
    expect(chosenMicrophone()).toBe("usb-mic");
    chooseMicrophone(null);
    expect(chosenMicrophone()).toBeNull();
  });

  it("lists the browser's microphones without Chrome's default and communications entries", async () => {
    devices([
      { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
      { kind: "audioinput", deviceId: "communications", label: "Communications" },
      { kind: "audioinput", deviceId: "mbp", label: "MacBook Pro Microphone" },
      { kind: "audioinput", deviceId: "usb", label: "USB Microphone" },
      { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
    ]);
    expect(await listMicrophones()).toEqual([
      { id: "mbp", label: "MacBook Pro Microphone" },
      { id: "usb", label: "USB Microphone" },
    ]);
  });

  it("says the names are hidden while the browser has not been allowed the microphone", async () => {
    devices([{ kind: "audioinput", deviceId: "x", label: "" }]);
    expect(await listMicrophones()).toBeNull();
  });
});

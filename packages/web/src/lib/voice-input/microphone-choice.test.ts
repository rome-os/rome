// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  chooseMicrophone,
  chosenMicrophone,
  findMicrophone,
  listMicrophones,
} from "./microphone-choice";

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
    chooseMicrophone({ id: "usb-mic", label: "USB Microphone" });
    expect(chosenMicrophone()).toEqual({ id: "usb-mic", label: "USB Microphone" });
    chooseMicrophone(null);
    expect(chosenMicrophone()).toBeNull();
  });

  it("reports the earlier choice when storage refuses a new one", () => {
    chooseMicrophone({ id: "usb-mic", label: "USB Microphone" });
    const setItem = rs.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(chooseMicrophone({ id: "headset", label: "Headset" })).toEqual({
      id: "usb-mic",
      label: "USB Microphone",
    });
    setItem.mockRestore();
  });

  it("reads a choice saved as a bare device id, before names were kept", () => {
    localStorage.setItem("rome.voiceInput.microphone", "usb-mic");
    expect(chosenMicrophone()).toEqual({ id: "usb-mic", label: "" });
  });

  it("finds the chosen microphone by id, else by name when the browser gives it a new id", () => {
    const usb = { id: "old-id", label: "USB Microphone" };
    const mbp = { id: "mbp", label: "MacBook Pro Microphone" };
    expect(findMicrophone(usb, [mbp, usb])).toEqual(usb);
    const renamed = { id: "new-id", label: "USB Microphone" };
    expect(findMicrophone(usb, [mbp, renamed])).toEqual(renamed);
    expect(findMicrophone(usb, [mbp])).toBeNull();
    expect(findMicrophone({ id: "old-id", label: "" }, [mbp, renamed])).toBeNull();
    expect(findMicrophone(null, [mbp])).toBeNull();
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

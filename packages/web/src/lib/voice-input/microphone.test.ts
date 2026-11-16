// @rstest-environment jsdom
import { describe, expect, it, rs } from "@rstest/core";
import { loudness, openMicrophoneStream } from "./microphone";
import { chooseMicrophone, chosenMicrophone } from "./microphone-choice";

function browser(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  devices: Array<Partial<MediaDeviceInfo>> = [],
) {
  const spy = rs.fn(getUserMedia);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: spy, enumerateDevices: async () => devices },
  });
  return spy;
}

const stream = { getTracks: () => [] } as unknown as MediaStream;
const failure = (name: string) => Object.assign(new Error(name), { name });

describe("opening the microphone", () => {
  it("records from the chosen microphone", async () => {
    const getUserMedia = browser(async () => stream);
    await openMicrophoneStream("usb");
    const audio = getUserMedia.mock.calls[0]?.[0]?.audio as MediaTrackConstraints;
    expect(audio.deviceId).toEqual({ exact: "usb" });
  });

  it("falls back to the system default, and switches the choice to it, when the chosen microphone is unplugged", async () => {
    chooseMicrophone({ id: "usb", label: "USB Microphone" });
    const getUserMedia = browser(async (constraints) => {
      if ((constraints.audio as MediaTrackConstraints).deviceId)
        throw failure("OverconstrainedError");
      return stream;
    });
    expect(await openMicrophoneStream("usb")).toBe(stream);
    const audio = getUserMedia.mock.calls[1]?.[0]?.audio as MediaTrackConstraints;
    expect(audio.deviceId).toBeUndefined();
    expect(chosenMicrophone()).toBeNull();
  });

  it("finds the chosen microphone by name when the browser gave it a new id on this page load", async () => {
    chooseMicrophone({ id: "old-id", label: "USB Microphone" });
    const usb = { getTracks: () => [] } as unknown as MediaStream;
    const stopped = rs.fn();
    const fallback = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
    const getUserMedia = browser(
      async (constraints) => {
        const id = (constraints.audio as MediaTrackConstraints).deviceId as
          | { exact: string }
          | undefined;
        if (!id) return fallback;
        if (id.exact === "new-id") return usb;
        throw failure("OverconstrainedError");
      },
      [
        { kind: "audioinput", deviceId: "mbp", label: "MacBook Pro Microphone" },
        { kind: "audioinput", deviceId: "new-id", label: "USB Microphone" },
      ],
    );
    expect(await openMicrophoneStream("old-id")).toBe(usb);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(stopped).toHaveBeenCalled();
    expect(chosenMicrophone()).toBe("new-id");
  });

  it("still reports a refused microphone rather than trying another", async () => {
    const getUserMedia = browser(async () => {
      throw failure("NotAllowedError");
    });
    await expect(openMicrophoneStream("usb")).rejects.toThrow("NotAllowedError");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("loudness", () => {
  const tone = (amplitude: number) =>
    Float32Array.from({ length: 1024 }, (_, i) => amplitude * Math.sin(i / 4));

  it("reads silence as 0", () => {
    expect(loudness(new Float32Array(1024))).toBe(0);
  });

  it("reads a quiet room as 0", () => {
    expect(loudness(tone(0.001))).toBe(0);
  });

  it("reads speech between 0 and 1, louder reading higher", () => {
    const soft = loudness(tone(0.02));
    const loud = loudness(tone(0.2));
    expect(soft).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(soft);
    expect(loud).toBeLessThan(1);
  });

  it("caps very loud input at 1", () => {
    expect(loudness(tone(1))).toBe(1);
  });
});

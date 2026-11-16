// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
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

/** A stream whose one track records from `deviceId`. */
function streamFrom(deviceId: string) {
  const stop = rs.fn();
  const track = { stop, getSettings: () => ({ deviceId }) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  return { stream: stream as unknown as MediaStream, stop };
}

const wanted = (constraints: MediaStreamConstraints) =>
  ((constraints.audio as MediaTrackConstraints).deviceId as { ideal: string } | undefined)?.ideal;

const failure = (name: string) => Object.assign(new Error(name), { name });

describe("opening the microphone", () => {
  afterEach(() => localStorage.clear());

  it("records from the system default when no microphone is chosen", async () => {
    const getUserMedia = browser(async () => streamFrom("default").stream);
    await openMicrophoneStream();
    expect(wanted(getUserMedia.mock.calls[0]![0]!)).toBeUndefined();
  });

  it("records from the chosen microphone", async () => {
    chooseMicrophone({ id: "usb", label: "USB Microphone" });
    const usb = streamFrom("usb").stream;
    const getUserMedia = browser(async () => usb);
    expect(await openMicrophoneStream()).toBe(usb);
    expect(wanted(getUserMedia.mock.calls[0]![0]!)).toBe("usb");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("records from the system default, and clears the choice, when the chosen microphone is unplugged", async () => {
    chooseMicrophone({ id: "usb", label: "USB Microphone" });
    const fallback = streamFrom("mbp").stream;
    const getUserMedia = browser(
      async () => fallback,
      [{ kind: "audioinput", deviceId: "mbp", label: "MacBook Pro Microphone" }],
    );
    expect(await openMicrophoneStream()).toBe(fallback);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(chosenMicrophone()).toBeNull();
  });

  it("finds the chosen microphone by name when the browser gave it a new id on this page load", async () => {
    chooseMicrophone({ id: "old-id", label: "USB Microphone" });
    const fallback = streamFrom("mbp");
    const usb = streamFrom("new-id").stream;
    const getUserMedia = browser(
      async (constraints) => (wanted(constraints) === "new-id" ? usb : fallback.stream),
      [
        { kind: "audioinput", deviceId: "mbp", label: "MacBook Pro Microphone" },
        { kind: "audioinput", deviceId: "new-id", label: "USB Microphone" },
      ],
    );
    expect(await openMicrophoneStream()).toBe(usb);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(fallback.stop).toHaveBeenCalled();
    expect(chosenMicrophone()).toEqual({ id: "new-id", label: "USB Microphone" });
  });

  it("records from the system default, and keeps the choice, when the browser fails to list the microphones", async () => {
    chooseMicrophone({ id: "old-id", label: "USB Microphone" });
    const fallback = streamFrom("mbp").stream;
    browser(async () => fallback);
    navigator.mediaDevices.enumerateDevices = rs.fn(async () => {
      throw failure("NotReadableError");
    });
    expect(await openMicrophoneStream()).toBe(fallback);
    expect(chosenMicrophone()).toEqual({ id: "old-id", label: "USB Microphone" });
  });

  it("keeps the choice when the browser lists no microphones", async () => {
    chooseMicrophone({ id: "usb", label: "USB Microphone" });
    const fallback = streamFrom("default").stream;
    browser(async () => fallback, []);
    expect(await openMicrophoneStream()).toBe(fallback);
    expect(chosenMicrophone()).toEqual({ id: "usb", label: "USB Microphone" });
  });

  it("still reports a refused microphone rather than trying another", async () => {
    chooseMicrophone({ id: "usb", label: "USB Microphone" });
    const getUserMedia = browser(async () => {
      throw failure("NotAllowedError");
    });
    await expect(openMicrophoneStream()).rejects.toThrow("NotAllowedError");
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

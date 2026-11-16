// @rstest-environment jsdom
import { describe, expect, it, rs } from "@rstest/core";
import { openMicrophoneStream } from "./microphone";
import { chooseMicrophone, chosenMicrophone } from "./microphone-choice";

function browser(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const spy = rs.fn(getUserMedia);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: spy },
  });
  return spy;
}

const stream = {} as MediaStream;
const failure = (name: string) => Object.assign(new Error(name), { name });

describe("opening the microphone", () => {
  it("records from the chosen microphone", async () => {
    const getUserMedia = browser(async () => stream);
    await openMicrophoneStream("usb");
    const audio = getUserMedia.mock.calls[0]?.[0]?.audio as MediaTrackConstraints;
    expect(audio.deviceId).toEqual({ exact: "usb" });
  });

  it("falls back to the system default, and switches the choice to it, when the chosen microphone is unplugged", async () => {
    chooseMicrophone("usb");
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

  it("still reports a refused microphone rather than trying another", async () => {
    const getUserMedia = browser(async () => {
      throw failure("NotAllowedError");
    });
    await expect(openMicrophoneStream("usb")).rejects.toThrow("NotAllowedError");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

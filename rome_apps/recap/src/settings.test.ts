import { describe, expect, it } from "@rstest/core";
import { RECAP_AUDIO_SPEED_RATES } from "./settings.js";

describe("recap settings", () => {
  it("maps audio speed presets to requested TTS rates", () => {
    expect(RECAP_AUDIO_SPEED_RATES).toEqual({
      slower: "-15%",
      normal: "default",
      faster: "+15%",
      fastest: "+30%",
    });
  });
});

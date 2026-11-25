import { describe, expect, it } from "@rstest/core";
import type { VoiceInputSource } from "../../voice-input/index.js";
import type { SpeakerSource } from "../../voice-output/speaker-source.js";
import { voiceConversationRoutes } from "./voice-conversation.js";

const speaker = { open: async () => ({ ok: false, reason: "not-configured" }) } as SpeakerSource;
// Rome Cloud's voice input list, as the microphone reads it.
const voiceList = (available: boolean) => {
  const asked = { count: 0 };
  const source = {
    available: () => true,
    info: async () => {
      asked.count++;
      return { available, place: null };
    },
  } as unknown as VoiceInputSource;
  return { source, asked };
};

async function ask(deps: Parameters<typeof voiceConversationRoutes>[0]) {
  return (await voiceConversationRoutes(deps).request("/voice-conversation")).json();
}

describe("GET /api/voice-conversation", () => {
  it("offers a voice conversation when the guardian's account is on the voice input list", async () => {
    expect(await ask({ speaker, voiceInput: voiceList(true).source })).toEqual({
      available: true,
    });
  });

  it("offers none to an account off the list, as the microphone shows none", async () => {
    expect(await ask({ speaker, voiceInput: voiceList(false).source })).toEqual({
      available: false,
    });
    expect(await ask({ speaker })).toEqual({ available: false });
  });

  it("offers none without a speaker", async () => {
    expect(await ask({ voiceInput: voiceList(true).source })).toEqual({
      available: false,
    });
  });
});

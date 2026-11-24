import { describe, expect, it } from "@rstest/core";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import type { SpeakerSource } from "../../voice-output/speaker-source.js";
import type { VoiceInputSource } from "../../voice-input/index.js";
import { voiceConversationRoutes } from "./voice-conversation.js";

const guardian: SessionActor = { kind: "guardian", userId: "seat", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "a", email: "a@example.com" };
const speaker = { open: async () => ({ ok: false, reason: "disabled" }) } as SpeakerSource;
const listening = (available: boolean) => ({ available: () => available }) as VoiceInputSource;

async function ask(
  actor: SessionActor | null,
  deps: Parameters<typeof voiceConversationRoutes>[0],
  on = true,
) {
  const app = voiceConversationRoutes(deps, async () => on);
  const request = async () => (await app.request("/voice-conversation")).json();
  return actor ? runWithSessionActor(actor, request) : request();
}

describe("GET /api/voice-conversation", () => {
  it("offers a voice conversation to the guardian while voice_mode is on and Rome can listen and speak", async () => {
    expect(await ask(guardian, { speaker, voiceInput: listening(true) })).toEqual({
      available: true,
    });
  });

  it("offers none while voice_mode is off, to anyone but the guardian, or when Rome cannot listen or speak", async () => {
    const all = { speaker, voiceInput: listening(true) };
    expect(await ask(guardian, all, false)).toEqual({ available: false });
    expect(await ask(visitor, all)).toEqual({ available: false });
    expect(await ask(null, all)).toEqual({ available: false });
    expect(await ask(guardian, { speaker, voiceInput: listening(false) })).toEqual({
      available: false,
    });
    expect(await ask(guardian, { voiceInput: listening(true) })).toEqual({ available: false });
  });
});

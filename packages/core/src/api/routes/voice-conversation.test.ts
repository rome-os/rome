import { describe, expect, it } from "@rstest/core";
import { DashboardAccessState } from "../../access/dashboard-access-state.js";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import type { VoiceInputSource } from "../../voice-input/index.js";
import type { SpeakerSource } from "../../voice-output/speaker-source.js";
import { voiceConversationRoutes } from "./voice-conversation.js";

const guardian: SessionActor = { kind: "guardian", userId: "seat", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "a", email: "a@example.com" };
const dashboardAccessState = new DashboardAccessState();
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

async function ask(
  actor: SessionActor | null,
  deps: Omit<Parameters<typeof voiceConversationRoutes>[0], "dashboardAccessState">,
) {
  const app = voiceConversationRoutes({ dashboardAccessState, ...deps });
  const request = async () => (await app.request("/voice-conversation")).json();
  return actor ? runWithSessionActor(actor, request) : request();
}

describe("GET /api/voice-conversation", () => {
  it("offers a voice conversation to the guardian whose account is on the voice input list", async () => {
    expect(await ask(guardian, { speaker, voiceInput: voiceList(true).source })).toEqual({
      available: true,
    });
  });

  it("offers none to an account off the list, as the microphone shows none", async () => {
    expect(await ask(guardian, { speaker, voiceInput: voiceList(false).source })).toEqual({
      available: false,
    });
    expect(await ask(guardian, { speaker })).toEqual({ available: false });
  });

  it("offers it to a dashboard admin on the guardian's voice input list", async () => {
    const team = new DashboardAccessState();
    team.setCloudEmailAccess(["a@example.com"]);
    const app = voiceConversationRoutes({
      dashboardAccessState: team,
      speaker,
      voiceInput: voiceList(true).source,
    });
    const answer = await runWithSessionActor(visitor, async () =>
      (await app.request("/voice-conversation")).json(),
    );
    expect(answer).toEqual({ available: true });
  });

  it("offers none to anyone off the team, without asking Rome Cloud", async () => {
    const list = voiceList(true);
    expect(await ask(visitor, { speaker, voiceInput: list.source })).toEqual({ available: false });
    expect(await ask(null, { speaker, voiceInput: list.source })).toEqual({ available: false });
    expect(list.asked.count).toBe(0);
  });

  it("offers none without a speaker", async () => {
    expect(await ask(guardian, { voiceInput: voiceList(true).source })).toEqual({
      available: false,
    });
  });
});

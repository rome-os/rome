import { describe, expect, it } from "@rstest/core";
import { DashboardAccessState } from "../../access/dashboard-access-state.js";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import type { VoiceInputSource } from "../../voice-input/index.js";
import type { SettingsRepository } from "../../db/repositories/settings.js";
import type { SpeakerSource, SpeakingChoice } from "../../voice-output/speaker-source.js";
import { voiceConversationRoutes } from "./voice-conversation.js";

const guardian: SessionActor = { kind: "guardian", userId: "seat", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "a", email: "a@example.com" };
const dashboardAccessState = new DashboardAccessState();
const speaker = { open: async () => ({ ok: false, reason: "not-configured" }) } as SpeakerSource;
/** Settings kept in memory. */
const memorySettings = () => {
  const stored = new Map<string, unknown>();
  return {
    stored,
    repo: {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: unknown) => void stored.set(key, value),
    } as unknown as SettingsRepository,
  };
};
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
  deps: Omit<
    Parameters<typeof voiceConversationRoutes>[0],
    "dashboardAccessState" | "settingsRepo"
  >,
) {
  const app = voiceConversationRoutes({
    dashboardAccessState,
    settingsRepo: memorySettings().repo,
    ...deps,
  });
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
      settingsRepo: memorySettings().repo,
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

describe("voice conversation settings", () => {
  const routes = (deps: { speaker?: SpeakerSource; available?: boolean } = {}) => {
    const settings = memorySettings();
    const app = voiceConversationRoutes({
      dashboardAccessState,
      settingsRepo: settings.repo,
      speaker: deps.speaker ?? speaker,
      voiceInput: voiceList(deps.available ?? true).source,
    });
    const call = (actor: SessionActor, path: string, init?: RequestInit) =>
      runWithSessionActor(actor, () => app.request(path, init));
    return { settings, call };
  };
  const put = (body: unknown): RequestInit => ({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("answers the defaults, then keeps a picked voice and speed", async () => {
    const { call, settings } = routes();
    expect(await (await call(guardian, "/voice-conversation/settings")).json()).toEqual({
      voice: "Iris",
      speed: 1,
    });
    const saved = await call(
      guardian,
      "/voice-conversation/settings",
      put({ voice: "Reid", speed: 1.2 }),
    );
    expect(saved.status).toBe(200);
    expect(await (await call(guardian, "/voice-conversation/settings")).json()).toEqual({
      voice: "Reid",
      speed: 1.2,
    });
    expect(settings.stored.get("voiceMode.speaking")).toEqual({ voice: "Reid", speed: 1.2 });
  });

  it("refuses a voice it does not list, a speed the provider cannot take, and anyone off the team", async () => {
    const { call, settings } = routes();
    expect(
      (await call(guardian, "/voice-conversation/settings", put({ voice: "Nobody", speed: 1 })))
        .status,
    ).toBe(400);
    expect(
      (await call(guardian, "/voice-conversation/settings", put({ voice: "Reid", speed: 2 })))
        .status,
    ).toBe(400);
    expect(
      (await call(visitor, "/voice-conversation/settings", put({ voice: "Reid", speed: 1 })))
        .status,
    ).toBe(404);
    expect((await call(visitor, "/voice-conversation/settings")).status).toBe(404);
    expect(settings.stored.size).toBe(0);
  });

  it("plays a sample of a voice at a speed, as a WAV file", async () => {
    const choices: (SpeakingChoice | undefined)[] = [];
    const said: string[] = [];
    const speaking = {
      async open(listener, choice) {
        choices.push(choice);
        return {
          ok: true,
          provider: "soniox",
          session: {
            format: { encoding: "pcm_s16le", sampleRate: 24_000 },
            say(id: string, text: string) {
              said.push(text);
              listener.onAudio({ sentenceId: id, streamId: "s", pcm: new Uint8Array(480) });
              listener.onSentenceEnd(id);
            },
            stop: () => [],
            close: () => {},
          },
        };
      },
    } as SpeakerSource;
    const { call } = routes({ speaker: speaking });
    const response = await call(guardian, "/voice-conversation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: "Grace", speed: 0.9, language: "zh" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(bytes.byteLength).toBe(44 + 480);
    // It sounds as a conversation would: the language picks only the sentence.
    expect(choices).toEqual([{ voice: "Grace", speed: 0.9 }]);
    expect(said).toEqual(["你好，我是 Rome。今天想聊点什么？"]);
  });

  it("plays nothing where no conversation is offered, and says so when the voice cannot be had", async () => {
    const preview = {
      method: "POST",
      body: JSON.stringify({ voice: "Iris", speed: 1, language: "en" }),
    };
    expect(
      (await routes({ available: false }).call(guardian, "/voice-conversation/preview", preview))
        .status,
    ).toBe(404);
    expect((await routes().call(visitor, "/voice-conversation/preview", preview)).status).toBe(404);
    expect((await routes().call(guardian, "/voice-conversation/preview", preview)).status).toBe(
      502,
    );
  });
});

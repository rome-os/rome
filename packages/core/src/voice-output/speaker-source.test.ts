import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { installEnvGateOverrides } from "@rome-os/libs/feature-flags/env-overrides";
import { resetFeatureGates, useFakeFeatureGates } from "@rome-os/libs/feature-flags/testing";
import type { SpeakerListener, SpeakerSession } from "./speaker.js";
import { createSpeakerSource } from "./speaker-source.js";
import {
  NO_SPEECH_CREDENTIALS,
  type SpeechCredentialOutcome,
  type SpeechCredentialSource,
} from "./speech-credentials.js";
import { type FakeTts, startFakeTts, until } from "./test-helpers.js";
import { VOICE_MODE_GATE_NAME, resolveVoiceModeEnabled } from "./voice-mode-gate.js";

const listener: SpeakerListener = {
  onAudio: () => {},
  onSentenceEnd: () => {},
  onSentenceError: () => {},
  onClosed: () => {},
};

let fake: FakeTts;
const opened: SpeakerSession[] = [];
const originalSlug = process.env.PANTHEON_SLUG;

beforeEach(async () => {
  fake = await startFakeTts();
});
afterEach(async () => {
  for (const session of opened.splice(0)) session.close();
  await fake.stop();
  await resetFeatureGates();
  if (originalSlug === undefined) delete process.env.PANTHEON_SLUG;
  else process.env.PANTHEON_SLUG = originalSlug;
});

function credentialsReturning(outcome: SpeechCredentialOutcome): SpeechCredentialSource & {
  asked: number;
} {
  const source = {
    asked: 0,
    get: async () => {
      source.asked++;
      return outcome;
    },
  };
  return source;
}

const granted = (overrides: Partial<{ provider: string; url: string }> = {}) =>
  credentialsReturning({
    kind: "granted",
    credentials: {
      provider: "soniox",
      url: fake.url,
      model: "tts-rt-v2",
      voice: "Bryce",
      token: "temp-token",
      sessionId: "speech-1",
      ...overrides,
    },
  });

describe("voice_mode gate", () => {
  it("is off by default", async () => {
    useFakeFeatureGates();
    expect(await resolveVoiceModeEnabled()).toBe(false);
  });

  it("is off when there is no feature-flag backend at all", async () => {
    expect(await resolveVoiceModeEnabled()).toBe(false);
  });

  it("is on when the gate passes for the instance", async () => {
    const gates = useFakeFeatureGates();
    process.env.PANTHEON_SLUG = "inst-1";
    gates.enable(VOICE_MODE_GATE_NAME, "inst-1");
    expect(await resolveVoiceModeEnabled()).toBe(true);
    process.env.PANTHEON_SLUG = "inst-2";
    expect(await resolveVoiceModeEnabled()).toBe(false);
  });

  it("fails closed when the backend breaks", async () => {
    const gates = useFakeFeatureGates();
    gates.enable(VOICE_MODE_GATE_NAME);
    gates.breakBackend();
    expect(await resolveVoiceModeEnabled()).toBe(false);
  });

  it("turns on with FEATURE_GATE_VOICE_MODE, with no backend and no instance slug", async () => {
    delete process.env.PANTHEON_SLUG;
    installEnvGateOverrides({ FEATURE_GATE_VOICE_MODE: "on" });
    expect(await resolveVoiceModeEnabled()).toBe(true);
  });

  it("stays off with FEATURE_GATE_VOICE_MODE=off even where the backend says on", async () => {
    useFakeFeatureGates().enable(VOICE_MODE_GATE_NAME);
    installEnvGateOverrides({ FEATURE_GATE_VOICE_MODE: "off" });
    expect(await resolveVoiceModeEnabled()).toBe(false);
  });
});

describe("speaker source", () => {
  it("makes no speaker, asks for no credential and opens no connection while voice mode is off", async () => {
    const credentials = granted();
    const source = createSpeakerSource({ credentials, enabled: async () => false });
    expect(await source.open(listener)).toEqual({ ok: false, reason: "disabled" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(credentials.asked).toBe(0);
    expect(fake.connections()).toBe(0);
  });

  it("is off by default through the real gate", async () => {
    const credentials = granted();
    const source = createSpeakerSource({ credentials });
    expect(await source.open(listener)).toEqual({ ok: false, reason: "disabled" });
    expect(credentials.asked).toBe(0);
    expect(fake.connections()).toBe(0);
  });

  it("opens a session on the credential's provider, address, model and voice once it is on", async () => {
    installEnvGateOverrides({ FEATURE_GATE_VOICE_MODE: "true" });
    const source = createSpeakerSource({ credentials: granted() });
    const outcome = await source.open(listener);
    if (!outcome.ok) throw new Error(`expected a session, got ${outcome.reason}`);
    opened.push(outcome.session);
    expect(outcome.provider).toBe("soniox");
    expect(outcome.credentialSessionId).toBe("speech-1");

    outcome.session.say("a", "你好。");
    await until(() => fake.received.some((m) => "text" in m));
    expect(fake.authorization()).toEqual(["Bearer temp-token"]);
    expect(fake.received[0]).toMatchObject({ model: "tts-rt-v2", voice: "Bryce" });
  });

  it("says plainly that nothing is set up while there is no credential source", async () => {
    const source = createSpeakerSource({
      credentials: NO_SPEECH_CREDENTIALS,
      enabled: async () => true,
    });
    expect(await source.open(listener)).toEqual({ ok: false, reason: "not-configured" });
    expect(fake.connections()).toBe(0);
  });

  it("passes on why a credential was not given", async () => {
    const enabled = async () => true;
    const open = (outcome: SpeechCredentialOutcome) =>
      createSpeakerSource({ credentials: credentialsReturning(outcome), enabled }).open(listener);
    expect(await open({ kind: "refused", code: "voice_mode_not_allowed" })).toEqual({
      ok: false,
      reason: "refused",
      detail: "voice_mode_not_allowed",
    });
    expect(await open({ kind: "signed-out" })).toEqual({ ok: false, reason: "signed-out" });
    expect(await open({ kind: "unavailable", detail: "no bearer" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("refuses a provider it has no adapter for, without connecting", async () => {
    const source = createSpeakerSource({
      credentials: granted({ provider: "elsewhere" }),
      enabled: async () => true,
    });
    expect(await source.open(listener)).toEqual({
      ok: false,
      reason: "unknown-provider",
      detail: "elsewhere",
    });
    expect(fake.connections()).toBe(0);
  });

  it("answers unavailable, not a throw, for an address that is no socket", async () => {
    const source = createSpeakerSource({
      credentials: granted({ url: "https://not-a-socket.example/tts" }),
      enabled: async () => true,
    });
    expect(await source.open(listener)).toEqual({ ok: false, reason: "unavailable" });
  });
});

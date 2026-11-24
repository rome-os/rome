import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { SpeakerListener, SpeakerSession } from "./speaker.js";
import { createSpeakerSource } from "./speaker-source.js";
import {
  NO_SPEECH_CREDENTIALS,
  type SpeechCredentialOutcome,
  type SpeechCredentialSource,
} from "./speech-credentials.js";
import {
  audioMessage,
  errorMessage,
  type FakeTts,
  startFakeTts,
  terminatedMessage,
  until,
} from "./test-helpers.js";

const listener: SpeakerListener = {
  onAudio: () => {},
  onSentenceEnd: () => {},
  onSentenceError: () => {},
  onClosed: () => {},
};

let fake: FakeTts;
const opened: SpeakerSession[] = [];

beforeEach(async () => {
  fake = await startFakeTts();
});
afterEach(async () => {
  for (const session of opened.splice(0)) session.close();
  await fake.stop();
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

describe("speaker source", () => {
  it("opens a session on the credential's provider, address, model and voice", async () => {
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
    });
    expect(await source.open(listener)).toEqual({ ok: false, reason: "not-configured" });
    expect(fake.connections()).toBe(0);
  });

  it("passes on why a credential was not given", async () => {
    const open = (outcome: SpeechCredentialOutcome) =>
      createSpeakerSource({ credentials: credentialsReturning(outcome) }).open(listener);
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
    });
    expect(await source.open(listener)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("counts what each session speaks on its credential, as sentences finish and when it closes", async () => {
    // One second of 24 kHz audio, in two frames.
    const half = Buffer.alloc(24_000);
    fake.onMessage = (message, reply) => {
      if (message.text === undefined || message.text_end !== true) return;
      const id = message.stream_id as string;
      reply(audioMessage(id, half));
      reply(audioMessage(id, half, true));
      reply(terminatedMessage(id));
    };
    const usage: { sessionId: string; characters: number; seconds: number }[] = [];
    const credentials = {
      ...granted(),
      recordUsage: (sessionId: string, used: { characters: number; seconds: number }) =>
        usage.push({ sessionId, ...used }),
    };
    const ended: string[] = [];
    const source = createSpeakerSource({ credentials });
    let frames = 0;
    const outcome = await source.open({
      ...listener,
      onAudio: () => frames++,
      onSentenceEnd: (id) => ended.push(id),
    });
    if (!outcome.ok) throw new Error(`expected a session, got ${outcome.reason}`);
    opened.push(outcome.session);

    outcome.session.say("a", "你好，Rome😀。");
    await until(() => ended.length === 1);
    expect(usage).toEqual([{ sessionId: "speech-1", characters: 9, seconds: 1 }]);

    // Sentences stopped before any of their audio came, sent or still
    // queued, are not counted.
    fake.onMessage = () => {};
    outcome.session.say("b", "再见。");
    outcome.session.say("c", "还有。");
    outcome.session.say("d", "never spoken");
    await until(() => fake.received.some((m) => m.text === "还有。"));
    outcome.session.stop();
    expect(usage).toHaveLength(1);

    // A sentence cut off part-way counts its text and the audio that came.
    fake.onMessage = (message, reply) => {
      if (message.text === undefined) return;
      reply(audioMessage(message.stream_id as string, half));
    };
    outcome.session.say("e", "说了一半");
    await until(() => frames === 3);
    outcome.session.close();
    expect(usage).toEqual([
      { sessionId: "speech-1", characters: 9, seconds: 1 },
      { sessionId: "speech-1", characters: 4, seconds: 0.5 },
    ]);
  });
});

describe("a speaking session whose credential is refused", () => {
  /** Hands out `temp-1`, `temp-2`, … in turn, each once the one before is retired. */
  function rotating(next: (n: number) => SpeechCredentialOutcome | null = () => null) {
    let n = 1;
    const source = {
      asked: 0,
      retired: [] as string[],
      get: async (): Promise<SpeechCredentialOutcome> => {
        source.asked++;
        return (
          (source.asked > 1 ? next(n) : null) ?? {
            kind: "granted",
            credentials: {
              provider: "soniox",
              url: fake.url,
              model: "tts-rt-v2",
              voice: "Iris",
              token: `temp-${n}`,
              sessionId: `speech-${n}`,
            },
          }
        );
      },
      retire: (sessionId: string) => {
        source.retired.push(sessionId);
        n++;
      },
    };
    return source;
  }

  /** Speaks every sentence, except on a connection whose key is in `refused`. */
  function speakUnless(refused: Set<string>) {
    const keyOf = new Map<unknown, string | undefined>();
    const spoken: { key: string | undefined; text: string }[] = [];
    fake.onMessage = (message, reply, socket) => {
      if (!keyOf.has(socket)) keyOf.set(socket, fake.authorization()[keyOf.size]);
      if (message.text === undefined || message.text_end !== true) return;
      const id = message.stream_id as string;
      const key = keyOf.get(socket);
      if (key && refused.has(key)) {
        reply(errorMessage(id, 401, "unauthenticated", "Invalid or expired temporary API key."));
      } else {
        spoken.push({ key, text: message.text as string });
        reply(audioMessage(id, Buffer.alloc(480), true));
      }
      reply(terminatedMessage(id));
    };
    return spoken;
  }

  async function openWith(credentials: SpeechCredentialSource) {
    const events: string[] = [];
    const source = createSpeakerSource({ credentials });
    const outcome = await source.open({
      onAudio: () => {},
      onSentenceEnd: (id) => events.push(`end ${id}`),
      onSentenceError: (id, error) => events.push(`error ${id} ${error.kind}`),
      onClosed: (error) => events.push(`closed ${error.kind}`),
    });
    if (!outcome.ok) throw new Error(`expected a session, got ${outcome.reason}`);
    opened.push(outcome.session);
    return { session: outcome.session, events };
  }

  it("retires it, moves to a fresh one and says the refused sentences again, in order", async () => {
    const refused = new Set<string>();
    const spoken = speakUnless(refused);
    const credentials = rotating();
    const { session, events } = await openWith(credentials);

    session.say("a", "钥匙还有效。");
    await until(() => events.length === 1);
    // The key expires, or is revoked, while the conversation goes on.
    refused.add("Bearer temp-1");
    session.say("b", "第二句。");
    session.say("c", "第三句。");
    await until(() => events.length === 3, "the sentences on the new key");

    expect(events).toEqual(["end a", "end b", "end c"]);
    expect(credentials.retired).toEqual(["speech-1"]);
    expect(credentials.asked).toBe(2);
    expect(fake.authorization()).toEqual(["Bearer temp-1", "Bearer temp-2"]);
    expect(spoken).toEqual([
      { key: "Bearer temp-1", text: "钥匙还有效。" },
      { key: "Bearer temp-2", text: "第二句。" },
      { key: "Bearer temp-2", text: "第三句。" },
    ]);

    // Later sentences go on the new key.
    session.say("d", "第四句。");
    await until(() => events.length === 4);
    expect(spoken.at(-1)).toEqual({ key: "Bearer temp-2", text: "第四句。" });
  });

  it("renews once, and fails as before when the fresh credential is refused too", async () => {
    const spoken = speakUnless(new Set(["Bearer temp-1", "Bearer temp-2"]));
    const credentials = rotating();
    const { session, events } = await openWith(credentials);

    session.say("a", "第一句。");
    await until(() => events.length === 1);
    expect(events).toEqual(["error a unauthorized"]);
    session.say("b", "第二句。");
    await until(() => events.length === 2);
    expect(events).toEqual(["error a unauthorized", "error b unauthorized"]);
    expect(credentials.asked).toBe(2);
    expect(spoken).toEqual([]);
  });

  it("fails the refused sentence when no fresh credential is given", async () => {
    speakUnless(new Set(["Bearer temp-1"]));
    const credentials = rotating(() => ({ kind: "refused", code: "speech_rate_limited" }));
    const { session, events } = await openWith(credentials);

    session.say("a", "第一句。");
    await until(() => events.length === 1);
    expect(events).toEqual(["error a unauthorized"]);
    expect(credentials.retired).toEqual(["speech-1"]);
    expect(fake.connections()).toBe(1);
  });

  it("asks again 30 s after no fresh credential could be had", async () => {
    const spoken = speakUnless(new Set(["Bearer temp-1"]));
    let tries = 0;
    const credentials = rotating(() =>
      ++tries === 1 ? { kind: "unavailable", detail: "Rome Cloud did not answer" } : null,
    );
    let at = 0;
    const events: string[] = [];
    const source = createSpeakerSource({ credentials, now: () => at });
    const outcome = await source.open({
      onAudio: () => {},
      onSentenceEnd: (id) => events.push(`end ${id}`),
      onSentenceError: (id, error) => events.push(`error ${id} ${error.kind}`),
      onClosed: (error) => events.push(`closed ${error.kind}`),
    });
    if (!outcome.ok) throw new Error(`expected a session, got ${outcome.reason}`);
    opened.push(outcome.session);

    outcome.session.say("a", "第一句。");
    await until(() => events.length === 1);
    // Within 30 s a refusal does not ask Rome Cloud again.
    at += 29_000;
    outcome.session.say("b", "第二句。");
    await until(() => events.length === 2);
    expect(events).toEqual(["error a unauthorized", "error b unauthorized"]);
    expect(credentials.asked).toBe(2);

    at += 1_000;
    outcome.session.say("c", "第三句。");
    await until(() => events.length === 3, "the sentence on a fresh key");
    expect(events.at(-1)).toBe("end c");
    expect(credentials.asked).toBe(3);
    expect(spoken).toEqual([{ key: fake.authorization().at(-1), text: "第三句。" }]);
  });
});

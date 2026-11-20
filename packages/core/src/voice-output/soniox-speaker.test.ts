import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createSonioxSpeaker, kindFor, type SonioxSpeakerOptions } from "./soniox-speaker.js";
import { splitForStreams } from "./split-text.js";
import type {
  SpeakerAudioFrame,
  SpeakerError,
  SpeakerErrorKind,
  SpeakerListener,
  SpeakerSession,
} from "./speaker.js";
import {
  audioMessage,
  errorMessage,
  type FakeClock,
  type FakeTts,
  fakeClock,
  type Sent,
  startFakeTts,
  terminatedMessage,
  until,
} from "./test-helpers.js";

const KEY = "snx_test_secret_0123456789abcdef";

let fake: FakeTts;
let clock: FakeClock;
const sessions: SpeakerSession[] = [];

beforeEach(async () => {
  fake = await startFakeTts();
  clock = fakeClock();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await fake.stop();
});

interface Heard {
  frames: SpeakerAudioFrame[];
  ended: string[];
  failed: Map<string, SpeakerError>;
  closed: SpeakerError[];
  listener: SpeakerListener;
}

function listen(): Heard {
  const heard: Heard = {
    frames: [],
    ended: [],
    failed: new Map(),
    closed: [],
    listener: {
      onAudio: (frame) => heard.frames.push(frame),
      onSentenceEnd: (id) => heard.ended.push(id),
      onSentenceError: (id, error) => heard.failed.set(id, error),
      onClosed: (error) => heard.closed.push(error),
    },
  };
  return heard;
}

function open(heard: Heard, options: Partial<SonioxSpeakerOptions> = {}): SpeakerSession {
  const session = createSonioxSpeaker({
    token: KEY,
    url: fake.url,
    schedule: clock.schedule,
    ...options,
  }).open(heard.listener);
  sessions.push(session);
  return session;
}

/** Text messages the adapter sent, by stream id. */
const texts = (): Sent[] => fake.received.filter((m) => "text" in m);
const configs = (): Sent[] => fake.received.filter((m) => "model" in m);
const cancels = (): Sent[] => fake.received.filter((m) => m.cancel === true);
const keepAlives = (): Sent[] => fake.received.filter((m) => m.keep_alive === true);

/** Waits until the session is connected: a sentence with nothing to say ends only then. */
async function connected(heard: Heard, session: SpeakerSession): Promise<void> {
  session.say("ready", " ");
  await until(() => heard.ended.includes("ready"), "the connection");
}

/** A run of samples `value, value, ...`, `samples` long. */
const pcm = (value: number, samples = 4): Buffer => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, i * 2);
  return buffer;
};

/** The server speaks each stream as soon as its text arrives: two frames, then the end. */
function speakAtOnce(): void {
  fake.onMessage = (message, reply) => {
    if (message.text === undefined || message.text_end !== true) return;
    const id = message.stream_id as string;
    reply(audioMessage(id, pcm(1)));
    reply(audioMessage(id, pcm(2), true));
    reply(terminatedMessage(id));
  };
}

describe("soniox speaker: one stream per sentence", () => {
  it("opens the connection with the key in the header and no api_key in the config", async () => {
    speakAtOnce();
    const heard = listen();
    const session = open(heard);
    expect(session.format).toEqual({ encoding: "pcm_s16le", sampleRate: 24_000 });
    session.say("a", "你好。");
    await until(() => heard.ended.length === 1, "the sentence to end");

    expect(fake.authorization()).toEqual([`Bearer ${KEY}`]);
    expect(configs()).toEqual([
      {
        stream_id: "s1",
        model: "tts-rt-v2",
        language: "zh",
        voice: "Iris",
        audio_format: "pcm_s16le",
        sample_rate: 24_000,
      },
    ]);
    expect(JSON.stringify(fake.received)).not.toContain(KEY);
  });

  it("takes the model, voice, language and sample rate from its options", async () => {
    speakAtOnce();
    const heard = listen();
    const session = open(heard, {
      model: "tts-rt-v3",
      voice: "Bryce",
      language: "en",
      sampleRate: 16_000,
    });
    expect(session.format.sampleRate).toBe(16_000);
    session.say("a", "Hello.");
    await until(() => heard.ended.length === 1);
    expect(configs()[0]).toMatchObject({
      model: "tts-rt-v3",
      voice: "Bryce",
      language: "en",
      sample_rate: 16_000,
    });
  });

  it("sends each sentence on its own stream and closes it with text_end in the same message", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 3 });
    session.say("one", "好的，我帮你看一下。");
    session.say("two", "pr#2345 的 CI 已经通过了。");
    session.say("three", "Only one lint warning.");
    await until(() => texts().length === 3, "three texts");

    expect(texts()).toEqual([
      { stream_id: "s1", text: "好的，我帮你看一下。", text_end: true },
      { stream_id: "s2", text: "pr#2345 的 CI 已经通过了。", text_end: true },
      { stream_id: "s3", text: "Only one lint warning.", text_end: true },
    ]);
    // Each stream's config comes before its text.
    for (const id of ["s1", "s2", "s3"]) {
      const at = (pick: (m: Sent) => boolean) => fake.received.findIndex(pick);
      expect(at((m) => m.stream_id === id && "model" in m)).toBeLessThan(
        at((m) => m.stream_id === id && "text" in m),
      );
    }
  });

  it("decodes audio into frames tagged with the sentence, and ends each sentence once", async () => {
    speakAtOnce();
    const heard = listen();
    const session = open(heard);
    session.say("a", "第一句。");
    await until(() => heard.ended.length === 1);
    session.say("b", "第二句。");
    await until(() => heard.ended.length === 2);

    expect(heard.frames.map((f) => [f.sentenceId, f.streamId, [...f.pcm.subarray(0, 2)]])).toEqual([
      ["a", "s1", [1, 0]],
      ["a", "s1", [2, 0]],
      ["b", "s1", [1, 0]],
      ["b", "s1", [2, 0]],
    ]);
    expect(heard.frames[0]?.pcm.byteLength).toBe(8);
    expect(heard.ended).toEqual(["a", "b"]);
    expect(heard.failed.size).toBe(0);
  });

  it("delivers a sentence's frames before its end, even as another sentence interleaves", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    session.say("b", "乙。");
    await until(() => texts().length === 2);
    fake.send(audioMessage("s2", pcm(20)));
    fake.send(audioMessage("s1", pcm(10)));
    fake.send(audioMessage("s2", pcm(21), true));
    fake.send(terminatedMessage("s2"));
    fake.send(audioMessage("s1", pcm(11), true));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.ended.length === 2);

    const firstOf = (id: string) =>
      heard.frames.filter((f) => f.sentenceId === id).map((f) => f.pcm[0]);
    expect(firstOf("a")).toEqual([10, 11]);
    expect(firstOf("b")).toEqual([20, 21]);
    expect(heard.ended).toEqual(["b", "a"]);
  });

  it("holds a stray byte of a frame for the next one, so frames hold whole samples", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "你好。");
    await until(() => texts().length === 1);
    const whole = pcm(0x0102, 3); // 6 bytes: 02 01 02 01 02 01
    fake.send(audioMessage("s1", whole.subarray(0, 3)));
    fake.send(audioMessage("s1", whole.subarray(3)));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.ended.length === 1);

    expect(heard.frames.every((f) => f.pcm.byteLength % 2 === 0)).toBe(true);
    expect(Buffer.concat(heard.frames.map((f) => f.pcm))).toEqual(whole);
  });

  it("ends a sentence with nothing to say without opening a stream", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("blank", "  \n ");
    await until(() => heard.ended.length === 1);
    expect(heard.ended).toEqual(["blank"]);
    expect(configs()).toEqual([]);
  });

  it("holds sentences said before the connection opens and sends them in order", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    session.say("b", "乙。");
    await until(() => texts().length === 2);
    expect(texts().map((m) => m.text)).toEqual(["甲。", "乙。"]);
  });
});

describe("soniox speaker: concurrency and stream ids", () => {
  it("runs at most five streams on a connection and starts the next sentence as one ends", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 5 });
    for (let i = 1; i <= 7; i++) session.say(`n${i}`, `第${i}句。`);
    await until(() => texts().length === 5);
    expect(texts().map((m) => m.stream_id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    // Nothing more starts while five are running.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(texts()).toHaveLength(5);

    fake.send(audioMessage("s3", pcm(1), true));
    fake.send(terminatedMessage("s3"));
    await until(() => texts().length === 6);
    expect(texts()[5]).toMatchObject({ text: "第6句。" });
    fake.send(terminatedMessage("s1"));
    await until(() => texts().length === 7);
    expect(texts()[6]).toMatchObject({ text: "第7句。" });
    expect(heard.ended).toEqual(["n3", "n1"]);
  });

  it("runs two streams at once by default and queues the third sentence", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    session.say("b", "乙。");
    session.say("c", "丙。");
    await until(() => texts().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(texts().map((m) => m.text)).toEqual(["甲。", "乙。"]);

    fake.send(audioMessage("s2", pcm(1), true));
    fake.send(terminatedMessage("s2"));
    await until(() => texts().length === 3);
    expect(texts()[2]).toMatchObject({ stream_id: "s2", text: "丙。" });
  });

  it("uses fewer streams when asked to, and never more than five", async () => {
    const heard = listen();
    const few = open(heard, { maxConcurrentStreams: 2 });
    for (let i = 1; i <= 4; i++) few.say(`n${i}`, `第${i}句。`);
    await until(() => texts().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(texts()).toHaveLength(2);
    few.close();

    const other = await startFakeTts();
    const many = createSonioxSpeaker({ token: KEY, url: other.url, maxConcurrentStreams: 50 }).open(
      listen().listener,
    );
    sessions.push(many);
    for (let i = 1; i <= 8; i++) many.say(`m${i}`, `第${i}句。`);
    await until(() => other.received.filter((m) => "text" in m).length === 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(other.received.filter((m) => "text" in m)).toHaveLength(5);
    many.close();
    await other.stop();
  });

  it("reuses a stream id only after the provider says terminated", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 1 });
    session.say("a", "甲。");
    session.say("b", "乙。");
    await until(() => texts().length === 1);
    // Audio ended, but no `terminated` yet: the id is still taken.
    fake.send(audioMessage("s1", pcm(1), true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(texts()).toHaveLength(1);

    fake.send(terminatedMessage("s1"));
    await until(() => texts().length === 2);
    expect(texts()[1]).toEqual({ stream_id: "s1", text: "乙。", text_end: true });
  });

  it("gives a stream running beside another a different id", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    session.say("b", "乙。");
    await until(() => texts().length === 2);
    expect(texts().map((m) => m.stream_id)).toEqual(["s1", "s2"]);
  });
});

describe("soniox speaker: keep-alive", () => {
  it("sends keep_alive every 25 s while nothing is being said", async () => {
    const heard = listen();
    await connected(heard, open(heard));
    clock.advance(24_999);
    expect(keepAlives()).toHaveLength(0);
    clock.advance(1);
    await until(() => keepAlives().length === 1);
    clock.advance(25_000);
    await until(() => keepAlives().length === 2);
    expect(keepAlives()[0]).toEqual({ keep_alive: true });
  });

  it("sends none while a sentence is being spoken, and starts again after it ends", async () => {
    const heard = listen();
    const session = open(heard);
    await connected(heard, session);
    session.say("a", "甲。");
    await until(() => texts().length === 1);

    // Two minutes of speech, with audio arriving so the stream never looks stalled.
    for (let i = 0; i < 8; i++) {
      clock.advance(15_000);
      const before = heard.frames.length;
      fake.send(audioMessage("s1", pcm(1)));
      await until(() => heard.frames.length === before + 1);
    }
    expect(keepAlives()).toHaveLength(0);

    fake.send(audioMessage("s1", pcm(1), true));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.ended.includes("a"));
    clock.advance(25_000);
    await until(() => keepAlives().length === 1);
  });

  it("stops the keep-alive when the session closes", async () => {
    const heard = listen();
    const session = open(heard);
    await connected(heard, session);
    expect(clock.pending()).toBe(1);
    session.close();
    expect(clock.pending()).toBe(0);
  });
});

describe("soniox speaker: stop", () => {
  it("cancels every running stream, drops the sentences waiting, and returns all their ids", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 2 });
    session.say("a", "甲。");
    session.say("b", "乙。");
    session.say("c", "丙。");
    await until(() => texts().length === 2);
    fake.send(audioMessage("s1", pcm(1)));
    await until(() => heard.frames.length === 1);

    expect(session.stop()).toEqual(["a", "b", "c"]);
    await until(() => cancels().length === 2);
    expect(cancels()).toEqual([
      { stream_id: "s1", cancel: true },
      { stream_id: "s2", cancel: true },
    ]);

    fake.send(terminatedMessage("s1"));
    fake.send(terminatedMessage("s2"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The waiting sentence never started, and a stopped one reports nothing.
    expect(texts()).toHaveLength(2);
    expect(heard.ended).toEqual([]);
    expect(heard.failed.size).toBe(0);
  });

  it("drops audio that reaches it after the stop", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    fake.send(audioMessage("s1", pcm(1)));
    await until(() => heard.frames.length === 1);

    session.stop();
    // Soniox sometimes sends one more frame before it says terminated.
    fake.send(audioMessage("s1", pcm(2)));
    fake.send(audioMessage("s1", pcm(3), true));
    fake.send(terminatedMessage("s1"));
    await until(() => cancels().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard.frames).toHaveLength(1);
    expect(heard.ended).toEqual([]);
  });

  it("speaks again after a stop, once the provider has ended the cancelled stream", async () => {
    speakAtOnce();
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 1 });
    fake.onMessage = (message, reply) => {
      if (message.cancel === true) reply(terminatedMessage(message.stream_id as string));
      else if (message.text === "慢。")
        return; // never answered
      else if (message.text === "快。") {
        reply(audioMessage("s1", pcm(9), true));
        reply(terminatedMessage("s1"));
      }
    };
    session.say("slow", "慢。");
    await until(() => texts().length === 1);
    expect(session.stop()).toEqual(["slow"]);
    session.say("fast", "快。");
    await until(() => heard.ended.length === 1);

    expect(heard.ended).toEqual(["fast"]);
    // The id came back after the cancelled stream's terminated.
    expect(texts()[1]).toMatchObject({ stream_id: "s1", text: "快。" });
    expect(heard.frames.map((f) => f.sentenceId)).toEqual(["fast"]);
  });

  it("gives up a slot when the provider never answers a cancel, without reusing its id", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 1 });
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    session.stop();
    session.say("b", "乙。");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(texts()).toHaveLength(1);

    clock.advance(2_000);
    await until(() => texts().length === 2);
    expect(texts()[1]).toMatchObject({ stream_id: "s2", text: "乙。" });
  });

  it("does nothing when nothing is being said", async () => {
    const heard = listen();
    const session = open(heard);
    expect(session.stop()).toEqual([]);
    await connected(heard, session);
    expect(cancels()).toEqual([]);
  });
});

describe("soniox speaker: errors", () => {
  const cases: Array<[number, string, SpeakerErrorKind]> = [
    [402, "organization_balance_exhausted", "quota-exhausted"],
    [402, "organization_monthly_budget_exhausted", "quota-exhausted"],
    [402, "project_monthly_budget_exhausted", "quota-exhausted"],
    [401, "unauthenticated", "unauthorized"],
    [403, "permission_denied", "unauthorized"],
    [403, "temp_api_key_session_expired", "unauthorized"],
    [408, "request_timeout", "timeout"],
    [413, "max_audio_duration_reached", "output-too-long"],
    [400, "invalid_request", "invalid-request"],
    [400, "model_not_available", "invalid-request"],
    [500, "internal_error", "provider-unavailable"],
    [503, "service_unavailable", "provider-unavailable"],
  ];

  for (const [status, type, kind] of cases) {
    it(`maps ${status} ${type} to ${kind}, for that sentence only`, async () => {
      const heard = listen();
      const session = open(heard);
      session.say("bad", "甲。");
      session.say("good", "乙。");
      await until(() => texts().length === 2);

      fake.send(errorMessage("s1", status, type, "the provider's words"));
      fake.send(terminatedMessage("s1"));
      await until(() => heard.failed.has("bad"));
      const error = heard.failed.get("bad") as SpeakerError;
      expect(error.kind).toBe(kind);
      expect(error.providerCode).toBe(type);
      expect(error.message).toContain(type);

      // The other sentence is not touched.
      fake.send(audioMessage("s2", pcm(1), true));
      fake.send(terminatedMessage("s2"));
      await until(() => heard.ended.length === 1);
      expect(heard.ended).toEqual(["good"]);
      expect(heard.closed).toEqual([]);
    });
  }

  it("reports a sentence once even when the provider errors and then ends the stream", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("bad", "甲。");
    await until(() => texts().length === 1);
    fake.send(errorMessage("s1", 408, "request_timeout"));
    fake.send(audioMessage("s1", pcm(1)));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.failed.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heard.failed.size).toBe(1);
    expect(heard.ended).toEqual([]);
    expect(heard.frames).toEqual([]);
  });

  it("keeps the audio that came before a 413 cut, and then reports the sentence", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("long", "甲。");
    await until(() => texts().length === 1);
    fake.send(audioMessage("s1", pcm(1)));
    fake.send(errorMessage("s1", 413, "max_audio_duration_reached"));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.failed.has("long"));
    expect(heard.frames).toHaveLength(1);
    expect(heard.failed.get("long")?.kind).toBe("output-too-long");
  });

  it("gives up a stream the provider goes quiet on, tells it to cancel, and says timeout", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    clock.advance(19_999);
    expect(heard.failed.size).toBe(0);
    clock.advance(1);
    expect(heard.failed.get("a")?.kind).toBe("timeout");
    await until(() => cancels().length === 1);
  });

  it("does not time out a stream that keeps sending", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    for (let i = 0; i < 3; i++) {
      clock.advance(15_000);
      const before = heard.frames.length;
      fake.send(audioMessage("s1", pcm(1)));
      await until(() => heard.frames.length === before + 1);
    }
    expect(heard.failed.size).toBe(0);
  });

  it("fails every open sentence and closes the session on an error with no stream", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    session.say("b", "乙。");
    await until(() => texts().length === 2);
    fake.send(errorMessage(undefined, 401, "unauthenticated", "bad credentials"));
    await until(() => heard.closed.length === 1);
    expect(heard.closed[0]?.kind).toBe("unauthorized");
    expect([...heard.failed.keys()]).toEqual(["a", "b"]);
    expect(heard.failed.get("a")?.kind).toBe("unauthorized");
  });

  it("tells a sentence said after the session failed that it is lost", async () => {
    const heard = listen();
    const session = open(heard);
    await connected(heard, session);
    fake.send(errorMessage(undefined, 402, "organization_balance_exhausted"));
    await until(() => heard.closed.length === 1);
    session.say("late", "晚了。");
    await until(() => heard.failed.has("late"));
    expect(heard.failed.get("late")?.kind).toBe("quota-exhausted");
    expect(heard.closed).toHaveLength(1);
  });

  it("skips messages that are not JSON objects", async () => {
    speakAtOnce();
    const heard = listen();
    const session = open(heard);
    await connected(heard, session);
    fake.onMessage = () => {};
    fake.send([1, 2]);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    expect(heard.closed).toEqual([]);
  });
});

describe("soniox speaker: the connection", () => {
  const refusals: Array<[number, SpeakerErrorKind]> = [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [402, "quota-exhausted"],
    [408, "timeout"],
    [429, "busy"],
    [500, "provider-unavailable"],
    [503, "provider-unavailable"],
    [404, "invalid-request"],
  ];
  for (const [status, kind] of refusals) {
    it(`fails the session as ${kind} when the upgrade is refused with ${status}`, async () => {
      fake.refuse(status);
      const heard = listen();
      const session = open(heard);
      session.say("a", "甲。");
      await until(() => heard.closed.length === 1);
      expect(heard.closed[0]?.kind).toBe(kind);
      expect(heard.failed.get("a")?.kind).toBe(kind);
      expect(heard.closed[0]?.message).toContain(String(status));
      expect(fake.received).toEqual([]);
    });
  }

  it("fails the session when the server drops the connection", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    fake.drop(1001, "Timeout");
    await until(() => heard.closed.length === 1);
    expect(heard.closed[0]?.kind).toBe("provider-unavailable");
    expect(heard.closed[0]?.message).toContain("1001");
    expect(heard.failed.get("a")?.kind).toBe("provider-unavailable");
  });

  it("fails the session when nothing listens at the address", async () => {
    // A port nothing listens on: the connect fails at once.
    const heard = listen();
    const session = open(heard, { url: "ws://127.0.0.1:1/tts-websocket" });
    session.say("a", "甲。");
    await until(() => heard.closed.length === 1);
    expect(heard.closed[0]?.kind).toBe("provider-unavailable");
  });

  it("fails the session when the connect takes longer than the timeout", async () => {
    // The server accepts TCP but never finishes the upgrade.
    const { createServer } = await import("node:net");
    const hang = createServer(() => {});
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const { port } = hang.address() as { port: number };
    try {
      const heard = listen();
      open(heard, { url: `ws://127.0.0.1:${port}/tts-websocket` });
      clock.advance(10_000);
      await until(() => heard.closed.length === 1);
      expect(heard.closed[0]?.message).toContain("connect timed out");
    } finally {
      hang.close();
    }
  });

  it("says nothing after close(), and closes the socket", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    session.close();
    fake.send(audioMessage("s1", pcm(1)));
    session.say("b", "乙。");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard.frames).toEqual([]);
    expect(heard.closed).toEqual([]);
    expect(heard.failed.size).toBe(0);
    expect(texts()).toHaveLength(1);
  });
});

describe("soniox speaker: the key stays secret", () => {
  it("keeps the key out of every error, even one the provider echoes back", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    session.say("b", "乙。");
    await until(() => texts().length === 2);
    fake.send(errorMessage("s1", 401, "unauthenticated", `bad key ${KEY} for you`));
    fake.send(errorMessage(undefined, 401, "unauthenticated", `Bearer ${KEY}`));
    await until(() => heard.closed.length === 1);

    const everything = JSON.stringify([
      [...heard.failed.values()].map((e) => [e.message, e.providerCode, e.kind]),
      heard.closed.map((e) => e.message),
    ]);
    expect(everything).not.toContain(KEY);
    expect(everything).toContain("[redacted]");
  });

  it("keeps the key out of a close reason the server echoes", async () => {
    const heard = listen();
    await connected(heard, open(heard));
    fake.drop(1008, `policy ${KEY}`);
    await until(() => heard.closed.length === 1);
    expect(heard.closed[0]?.message).not.toContain(KEY);
  });

  it("sends the key nowhere but the Authorization header", async () => {
    speakAtOnce();
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => heard.ended.length === 1);
    expect(fake.authorization()).toEqual([`Bearer ${KEY}`]);
    expect(JSON.stringify(fake.received)).not.toContain(KEY);
    expect(JSON.stringify(fake.received)).not.toContain("api_key");
  });
});

describe("soniox speaker: sentences too long for one stream", () => {
  it("speaks the parts one after another, each within the limits, as one sentence", async () => {
    const heard = listen();
    const session = open(heard);
    // 12,000 characters of Latin text: far over what 2 minutes of audio holds.
    const long = "word ".repeat(2400).trim();
    const parts = splitForStreams(long);
    expect(parts.length).toBeGreaterThan(2);
    session.say("long", long);

    for (let i = 0; i < parts.length; i++) {
      await until(() => texts().length === i + 1, `part ${i + 1}`);
      // The next part waits for this one to end.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(texts()).toHaveLength(i + 1);
      expect(heard.ended).toEqual([]);
      fake.send(audioMessage("s1", pcm(i + 1), true));
      fake.send(terminatedMessage("s1"));
    }
    await until(() => heard.ended.length === 1);

    const sent = texts().map((m) => m.text as string);
    expect(sent).toEqual(parts);
    expect(sent.every((part) => part.length <= 5000)).toBe(true);
    expect(sent.join(" ")).toBe(long);
    expect(heard.ended).toEqual(["long"]);
    expect(heard.frames.map((f) => f.sentenceId)).toEqual(parts.map(() => "long"));
  });

  it("does not start the next part of a sentence that failed", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("long", "word ".repeat(2400).trim());
    await until(() => texts().length === 1);
    fake.send(errorMessage("s1", 500, "internal_error"));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.failed.has("long"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(texts()).toHaveLength(1);
  });
});

const BUSY_TYPES: Array<[number, string]> = [
  [400, "max_concurrent_streams_reached"],
  [429, "limit_exceeded"],
  [429, "max_concurrent_connections_reached"],
];

/** The server answers every stream with `busy` and its end, as a full account does. */
function alwaysBusy(status: number, type: string): void {
  fake.onMessage = (message, reply) => {
    if (message.text === undefined) return;
    const id = message.stream_id as string;
    reply(errorMessage(id, status, type));
    reply(terminatedMessage(id));
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("soniox speaker: an account with no room", () => {
  for (const [status, type] of BUSY_TYPES) {
    it(`holds a sentence that got ${type}, runs fewer streams, and speaks it in its turn`, async () => {
      const heard = listen();
      const session = open(heard, { maxConcurrentStreams: 3 });
      session.say("a", "甲。");
      session.say("b", "乙。");
      session.say("c", "丙。");
      session.say("d", "丁。");
      await until(() => texts().length === 3);

      fake.send(errorMessage("s3", status, type));
      fake.send(terminatedMessage("s3"));
      await settle();
      // No failure, and no new stream: the two running ones are the most it runs now.
      expect(heard.failed.size).toBe(0);
      expect(texts()).toHaveLength(3);

      // A stream ends: the held sentence starts again, ahead of the one said after it.
      fake.send(audioMessage("s1", pcm(1), true));
      fake.send(terminatedMessage("s1"));
      await until(() => texts().length === 4);
      expect(texts()[3]).toMatchObject({ text: "丙。" });
      await settle();
      expect(texts()).toHaveLength(4);

      fake.send(audioMessage("s2", pcm(2), true));
      fake.send(terminatedMessage("s2"));
      await until(() => texts().length === 5);
      expect(texts()[4]).toMatchObject({ text: "丁。" });
      expect(heard.failed.size).toBe(0);
      expect(heard.closed).toEqual([]);
    });
  }

  it("keeps the lower limit for the rest of the session", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 4 });
    for (const [i, text] of ["甲。", "乙。", "丙。", "丁。"].entries()) session.say(`n${i}`, text);
    await until(() => texts().length === 4);
    // The fourth is refused while three run.
    fake.send(errorMessage("s4", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s4"));
    await settle();
    for (const id of ["s1", "s2", "s3"]) {
      fake.send(audioMessage(id, pcm(1), true));
      fake.send(terminatedMessage(id));
    }
    await until(() => texts().length === 5);
    session.say("e", "戊。");
    session.say("f", "己。");
    session.say("g", "庚。");
    await until(() => texts().length === 7);
    await settle();
    // The held sentence and three more: at most three at once, as when the account said no.
    expect(texts()).toHaveLength(7);
    expect(heard.failed.size).toBe(0);
  });

  it("holds the part of a long sentence that was refused, not the whole sentence", async () => {
    const heard = listen();
    const session = open(heard, { splitLimits: { maxChars: 10, maxSeconds: 100 } });
    session.say("long", "aaaa bbbb cccc dddd");
    await until(() => texts().length === 1);
    expect(texts()[0]?.text).toBe("aaaa bbbb");
    fake.send(audioMessage("s1", pcm(1), true));
    fake.send(terminatedMessage("s1"));
    await until(() => texts().length === 2);
    expect(texts()[1]?.text).toBe("cccc dddd");

    fake.send(errorMessage("s1", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s1"));
    await settle();
    clock.advance(250);
    await until(() => texts().length === 3);
    expect(texts()[2]?.text).toBe("cccc dddd");
    fake.send(audioMessage("s1", pcm(2), true));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.ended.length === 1);
    expect(heard.failed.size).toBe(0);
  });

  it("waits 250 ms, 500 ms, 1 s, then 2 s at a time when none of its streams is running", async () => {
    alwaysBusy(429, "limit_exceeded");
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    await settle();

    for (const [i, wait] of [250, 500, 1000, 2000, 2000, 2000, 2000, 2000].entries()) {
      clock.advance(wait - 1);
      await settle();
      expect(texts()).toHaveLength(i + 1);
      clock.advance(1);
      await until(() => texts().length === i + 2, `attempt ${i + 2}`);
      await settle();
    }
    // The waits so far add up to 11.75 s: the ninth refusal is final.
    await until(() => heard.failed.has("a"), "the sentence to fail");
    expect(heard.failed.get("a")?.kind).toBe("busy");
    expect(texts()).toHaveLength(9);
    expect(heard.closed).toEqual([]);
    expect(heard.ended).toEqual([]);
  });

  for (const [status, type] of BUSY_TYPES) {
    it(`fails the sentence as busy at last when the account keeps saying ${type}`, async () => {
      alwaysBusy(status, type);
      const heard = listen();
      const session = open(heard);
      session.say("a", "甲。");
      await until(() => texts().length === 1);
      for (let i = 1; i < 9; i++) {
        await settle();
        clock.advance(2_000);
        await until(() => texts().length === i + 1);
      }
      await until(() => heard.failed.has("a"));
      expect(heard.failed.get("a")).toMatchObject({ kind: "busy", providerCode: type });
    });
  }

  it("starts the waits over after a stream gets through", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    fake.send(errorMessage("s1", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s1"));
    await settle();
    clock.advance(250);
    await until(() => texts().length === 2);
    fake.send(audioMessage("s1", pcm(1), true));
    fake.send(terminatedMessage("s1"));
    await until(() => heard.ended.includes("a"));

    session.say("b", "乙。");
    await until(() => texts().length === 3);
    fake.send(errorMessage("s1", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s1"));
    await settle();
    clock.advance(250);
    await until(() => texts().length === 4);
  });

  it("sends the sentences held behind a refused one in the order they were said", async () => {
    const heard = listen();
    const session = open(heard, { maxConcurrentStreams: 2 });
    session.say("a", "甲。");
    session.say("b", "乙。");
    session.say("c", "丙。");
    await until(() => texts().length === 2);
    // Both running streams are refused, in the opposite order.
    fake.send(errorMessage("s2", 429, "limit_exceeded"));
    fake.send(errorMessage("s1", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s2"));
    fake.send(terminatedMessage("s1"));
    await settle();
    clock.advance(250);
    await until(() => texts().length === 3);
    fake.send(audioMessage("s2", pcm(1), true));
    fake.send(terminatedMessage("s2"));
    await until(() => texts().length === 4);
    fake.send(audioMessage("s1", pcm(1), true));
    fake.send(terminatedMessage("s1"));
    await until(() => texts().length === 5);
    expect(
      texts()
        .slice(2)
        .map((m) => m.text),
    ).toEqual(["甲。", "乙。", "丙。"]);
    expect(heard.failed.size).toBe(0);
  });

  it("drops the wait when stop() is called, and speaks the next sentence at once", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    fake.send(errorMessage("s1", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s1"));
    await settle();

    expect(session.stop()).toEqual(["a"]);
    clock.advance(10_000);
    await settle();
    expect(texts()).toHaveLength(1);
    expect(heard.failed.size).toBe(0);

    session.say("b", "乙。");
    await until(() => texts().length === 2);
    expect(texts()[1]).toMatchObject({ text: "乙。" });
  });

  it("clears the wait timer when the session closes", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    fake.send(errorMessage("s1", 429, "limit_exceeded"));
    fake.send(terminatedMessage("s1"));
    await settle();
    session.close();
    expect(clock.pending()).toBe(0);
  });

  it("still fails the whole session on a connection-level refusal that names no stream", async () => {
    const heard = listen();
    const session = open(heard);
    session.say("a", "甲。");
    await until(() => texts().length === 1);
    fake.send(errorMessage(undefined, 429, "max_concurrent_connections_reached"));
    await until(() => heard.closed.length === 1);
    expect(heard.closed[0]?.kind).toBe("busy");
    expect(heard.failed.get("a")?.kind).toBe("busy");
  });
});

describe("soniox error kinds", () => {
  it("reads the provider's id before the status for the stream cap, which it sends as 400", () => {
    expect(kindFor(400, "max_concurrent_streams_reached")).toBe("busy");
    expect(kindFor(400, "invalid_request")).toBe("invalid-request");
    expect(kindFor(429, undefined)).toBe("busy");
    expect(kindFor(0, undefined)).toBe("provider-unavailable");
  });
});

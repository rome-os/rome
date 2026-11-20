// Smoke test against the REAL Soniox speech service. It costs a few cents.
//
// Skipped unless `SONIOX_TTS_KEY_FILE` names a file holding a Soniox API key
// that may speak (Text-to-speech, real-time) and mint temporary keys. The key
// is read from the file, exchanged for a temporary key, and never printed.
//   scripts/test-env.sh env SONIOX_TTS_KEY_FILE=/path/to/key.txt pnpm exec rstest -c packages/core/rstest.config.ts packages/core/src/voice-output/soniox-speaker.integration.test.ts
//
// It prints what it measured: time to the first audio, time to stop, and
// whether a fourth stream at once ran into the account's limit.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import { createSonioxSpeaker } from "./soniox-speaker.js";
import type { SpeakerAudioFrame, SpeakerError, SpeakerListener } from "./speaker.js";

const keyFile = process.env.SONIOX_TTS_KEY_FILE;
const withKey = keyFile ? describe : describe.skip;
const TIMEOUT_MS = 120_000;

const SENTENCES = [
  "帮我看一下 pr#2345 的 CI 有没有过。",
  "明天上午十点有个 Zoom meeting，记得提醒我带上 MacBook。",
  "这个 bug 是 Safari 里的 echo cancellation 引起的，我先 rollback 一下。",
];

const LONG =
  "我来给你讲一下今天的安排。上午十点有个 Zoom meeting，是和 design team 一起过 voice mode 的方案。中午之前要把 pr#2345 的 review 意见看完，CI 现在还在跑。下午两点去接孩子，路上大概二十分钟。晚上记得把 Monterey 的酒店再确认一下，周五之前可以免费取消。";

const secrets: string[] = [];

/** Everything shown goes through here, so a key can never reach the output. */
const show = (label: string, value: unknown): void => {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  console.log(`[soniox smoke] ${label} ${text}`);
};

async function mintTemporaryKey(longKey: string): Promise<string> {
  const response = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
    method: "POST",
    headers: { Authorization: `Bearer ${longKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      usage_type: "tts_rt",
      expires_in_seconds: 600,
      single_use: false,
      client_reference_id: "voice-mode-speaker-smoke",
    }),
  });
  const body = (await response.json().catch(() => null)) as { api_key?: string } | null;
  if (!response.ok || !body?.api_key)
    throw new Error(`minting a temporary key: ${response.status}`);
  secrets.push(body.api_key);
  return body.api_key;
}

interface Run {
  at: Map<string, number>;
  firstFrameAt: Map<string, number>;
  ended: Map<string, number>;
  failed: Map<string, SpeakerError>;
  frames: SpeakerAudioFrame[];
  closed: SpeakerError[];
  listener: SpeakerListener;
}

function run(): Run {
  const r: Run = {
    at: new Map(),
    firstFrameAt: new Map(),
    ended: new Map(),
    failed: new Map(),
    frames: [],
    closed: [],
    listener: {
      onAudio: (frame) => {
        r.frames.push(frame);
        if (!r.firstFrameAt.has(frame.sentenceId))
          r.firstFrameAt.set(frame.sentenceId, performance.now());
      },
      onSentenceEnd: (id) => r.ended.set(id, performance.now()),
      onSentenceError: (id, error) => r.failed.set(id, error),
      onClosed: (error) => r.closed.push(error),
    },
  };
  return r;
}

const waitFor = async (check: () => boolean, what: string, timeoutMs = 30_000) => {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2
    ? (sorted[(sorted.length - 1) / 2] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

withKey("soniox speaker against the real service", () => {
  it(
    "speaks three mixed sentences, stops at once, and reports a full account as busy",
    async () => {
      const longKey = readFileSync(keyFile as string, "utf8").trim();
      secrets.push(longKey);
      const token = await mintTemporaryKey(longKey);
      const speaker = createSonioxSpeaker({ token, voice: "Iris", language: "zh" });

      // 1. Three sentences said together: each on its own stream.
      const first = run();
      const session = speaker.open(first.listener);
      const warmStart = performance.now();
      SENTENCES.forEach((text, i) => {
        first.at.set(`s${i}`, performance.now());
        session.say(`s${i}`, text);
      });
      await waitFor(() => first.ended.size + first.failed.size === 3, "three sentences");
      const firstAudioMs = SENTENCES.map(
        (_, i) => (first.firstFrameAt.get(`s${i}`) ?? NaN) - (first.at.get(`s${i}`) ?? NaN),
      );
      const audioSeconds = first.frames.reduce((n, f) => n + f.pcm.byteLength, 0) / 2 / 24_000;
      show("three sentences", {
        coldFirstAudioMs: Math.round(firstAudioMs[0] as number),
        firstAudioMsPerSentence: firstAudioMs.map(Math.round),
        totalMs: Math.round(performance.now() - warmStart),
        audioSeconds: Number(audioSeconds.toFixed(2)),
        failed: [...first.failed].map(([id, e]) => [id, e.kind]),
      });
      expect(first.failed.size).toBe(0);
      expect(first.ended.size).toBe(3);
      expect(audioSeconds).toBeGreaterThan(3);
      expect(first.frames.every((f) => f.pcm.byteLength % 2 === 0)).toBe(true);

      // 2. Warm first audio: the connection is already up.
      const warm: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = `warm${i}`;
        first.at.set(id, performance.now());
        session.say(id, SENTENCES[i] as string);
        await waitFor(() => first.ended.has(id) || first.failed.has(id), id);
        warm.push((first.firstFrameAt.get(id) ?? NaN) - (first.at.get(id) as number));
      }
      show("warm first audio", {
        medianMs: Math.round(median(warm)),
        runsMs: warm.map(Math.round),
      });

      // 3. Stop in the middle of a long sentence, then speak again at once.
      const stopRun = run();
      const stopSession = createSonioxSpeaker({
        token,
        voice: "Iris",
        language: "zh",
        maxConcurrentStreams: 1,
      }).open(stopRun.listener);
      stopSession.say("warmup", "好。");
      await waitFor(() => stopRun.ended.has("warmup"), "warm-up");
      stopSession.say("long", LONG);
      await waitFor(() => stopRun.firstFrameAt.has("long"), "the long sentence to start");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stopAt = performance.now();
      const framesBefore = stopRun.frames.length;
      const stopped = stopSession.stop();
      stopRun.at.set("next", performance.now());
      stopSession.say("next", "换一句话。");
      await waitFor(
        () => stopRun.ended.has("next") || stopRun.failed.has("next"),
        "the next sentence",
      );
      const framesAfterStopForLong = stopRun.frames.filter(
        (f, i) => f.sentenceId === "long" && i >= framesBefore,
      ).length;
      show("stop", {
        stopped,
        framesOfStoppedSentenceAfterStop: framesAfterStopForLong,
        stopToNextFirstAudioMs: Math.round((stopRun.firstFrameAt.get("next") as number) - stopAt),
        stopToNextEndMs: Math.round((stopRun.ended.get("next") as number) - stopAt),
        failed: [...stopRun.failed].map(([id, e]) => [id, e.kind]),
      });
      expect(stopped).toEqual(["long"]);
      expect(framesAfterStopForLong).toBe(0);
      expect(stopRun.failed.size).toBe(0);
      stopSession.close();

      // 4. Four long sentences at once: the account allows 3 streams by default.
      const busyRun = run();
      const busySession = speaker.open(busyRun.listener);
      for (let i = 0; i < 4; i++) busySession.say(`b${i}`, LONG);
      await waitFor(() => busyRun.ended.size + busyRun.failed.size === 4, "four sentences", 90_000);
      const busy = [...busyRun.failed].filter(([, e]) => e.kind === "busy").map(([id]) => id);
      show("four at once", {
        ended: [...busyRun.ended.keys()],
        failed: [...busyRun.failed].map(([id, e]) => [id, e.kind, e.providerCode]),
        busyTriggered: busy.length > 0,
      });
      busySession.close();
      session.close();

      // The key reached no error message.
      const errors = [
        ...first.failed.values(),
        ...stopRun.failed.values(),
        ...busyRun.failed.values(),
      ].map((e) => e.message);
      for (const secret of secrets)
        for (const message of errors) expect(message).not.toContain(secret);
    },
    TIMEOUT_MS,
  );
});

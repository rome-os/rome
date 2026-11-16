// Rule 14: you can see Rome hearing you. While listening, the message field's form moves while
// the microphone hears sound and holds still in silence. The verifier plays its own recording,
// sound, silence, sound, and photographs the form, so the check holds for a pulse, a meter or a
// waveform alike. No words reach the field, so only the sign of hearing changes its pixels.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isListening,
  openPage,
  readRecord,
  recordField,
  voiceForm,
  waitForControlReturn,
  waitForListening,
} from "../lib/product.mjs";
import { useTranscriber } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { micState, watchPage } from "../lib/watch.mjs";

/** The recording, in seconds from the microphone opening: when sound plays. */
export const SOUND = [
  [1, 4],
  [7, 10],
];
const LENGTH_S = 11;
/** How late a photograph may find the sound's start. */
const FRAME_SLACK_S = 0.2;
/** How soon the form must settle once sound stops, start moving once it starts, and the longest it may hold still during sound. */
export const SETTLE_MS = 500;

export default {
  rule: "14",
  title: "You can see Rome hearing you",
  phase: 4,
  async run(ctx) {
    await useTranscriber(ctx);
    if (ctx.transcriber === "stand-in") await ctx.env.transcriber({ mode: "stand-in", text: "" });
    const mic = join(tmpdir(), "voice-verify-sound-silence-sound.wav");
    writeFileSync(mic, soundWav());
    const opened = await openPage(ctx.env, { mic });
    try {
      const { page } = opened;
      await watchPage(page);
      const { control, form, field } = await voiceForm(page);
      await field.fill("");
      await recordField(field, control);
      await control.click();
      await waitForListening(page, control);
      const [track] = (await micState(page)).tracks;
      if (!track)
        return ruleResult([
          required(check("the microphone opened", "fail", "listening opened no capture track")),
        ]);
      const frames = await photograph(page, form, track.openedAt + LENGTH_S * 1000);
      const stillListening = await isListening(control);
      await control.click().catch(() => {});
      await waitForControlReturn(page, control);
      const { samples } = await readRecord(page);
      const typed = samples.filter(([, text]) => text.trim() !== "");
      if (typed.length > 0)
        return ruleResult([
          required(
            check(
              "the form shows only hearing",
              "not_checked",
              `words reached the field ("${typed[0][1].trim()}"), so the photographs cannot tell hearing from text`,
            ),
          ),
        ]);
      if (!stillListening)
        return ruleResult([
          required(check("listening lasted the recording", "fail", "listening stopped by itself")),
        ]);
      return ruleResult(score(frames, soundClock(frames, track.openedAt)));
    } finally {
      await opened.close();
    }
  },
};

/** Photographs the form until `until` (page clock): `[{ at, changed }]`, oldest first. */
async function photograph(page, form, until) {
  const frames = [];
  let last = null;
  for (;;) {
    const at = await page.evaluate(() => performance.now());
    if (at >= until) return frames;
    const box = await form.boundingBox();
    const shot = await page.screenshot({ clip: box, caret: "hide", animations: "allow" });
    if (last) frames.push({ at, changed: !shot.equals(last) });
    last = shot;
  }
}

/**
 * When the recording started, in the page clock. Chrome starts playing it a little after the
 * capture opens, so the first change after the first sound is due marks it. A form that moves
 * before then keeps the capture's opening, and fails in the silence anyway.
 */
function soundClock(frames, openedAt) {
  const [first] = SOUND[0];
  const moved = frames.find((f) => f.changed && f.at >= openedAt + first * 1000);
  if (!moved || frames.some((f) => f.changed && f.at < openedAt + first * 1000)) return openedAt;
  return Math.min(moved.at - first * 1000, openedAt + SETTLE_MS);
}

/** A check per stretch of sound, and one for the silence between, timed from `zero`. */
function score(frames, zero) {
  const within = (from, to) =>
    frames.filter((f) => f.at - zero >= from * 1000 && f.at - zero < to * 1000);
  // During sound the form changes at least once in every stretch of SETTLE_MS.
  const checks = SOUND.map(([from, to], i) => {
    const still = [];
    for (let t = from + SETTLE_MS / 1000; t + SETTLE_MS / 1000 <= to; t += SETTLE_MS / 1000)
      if (!within(t, t + SETTLE_MS / 1000).some((f) => f.changed)) still.push(t);
    const seen = within(from + SETTLE_MS / 1000, to);
    return required(
      check(
        `moves with sound ${i + 1}`,
        seen.length > 0 && still.length === 0 ? "pass" : "fail",
        still.length === 0
          ? `the form changed in every ${SETTLE_MS} ms from ${from + SETTLE_MS / 1000} s to ${to} s (${seen.filter((f) => f.changed).length} of ${seen.length} photographs)`
          : `the form held still for ${SETTLE_MS} ms from ${still.map((t) => `${t.toFixed(1)} s`).join(", ")}, while sound played`,
      ),
    );
  });
  const [, end] = SOUND[0];
  const [next] = SOUND[1];
  // The clock is found from a photograph, so it may run a frame late; the next sound's first
  // frame stays out of the silence.
  const quiet = within(end + SETTLE_MS / 1000, next - FRAME_SLACK_S);
  const moved = quiet.filter((f) => f.changed).length;
  checks.push(
    required(
      check(
        "holds still in silence",
        quiet.length > 0 && moved === 0 ? "pass" : "fail",
        `${moved} of ${quiet.length} photographs from ${end + SETTLE_MS / 1000} s to ${next - FRAME_SLACK_S} s changed${
          moved
            ? ` (at ${quiet
                .filter((f) => f.changed)
                .map((f) => `${((f.at - zero) / 1000).toFixed(2)} s`)
                .join(", ")})`
            : ""
        }; the bar is none`,
      ),
    ),
  );
  return checks;
}

/**
 * 16 kHz mono 16-bit WAV: silence, with a 200 Hz tone during each stretch of `SOUND`, its
 * loudness rising and falling four times a second, as syllables do.
 */
function soundWav() {
  const rate = 16000;
  const samples = rate * LENGTH_S;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    if (!SOUND.some(([from, to]) => t >= from && t < to)) continue;
    const loud = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    data.writeInt16LE(Math.round(8000 * loud * Math.sin(2 * Math.PI * 200 * t)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

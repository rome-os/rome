// Speaks one short text on a session of its own, for Settings to let the
// guardian hear a voice before picking it.

import type { SpeakerSource, SpeakingChoice } from "./speaker-source.js";

/** A sample longer than this is given up. */
const SAMPLE_TIMEOUT_MS = 15_000;

/** `text` spoken as `choice` says, as a WAV file, or null when the speaker could not. */
export async function speakSample(
  speaker: SpeakerSource,
  choice: SpeakingChoice,
  text: string,
  timeoutMs = SAMPLE_TIMEOUT_MS,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let settle: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const opened = await speaker.open(
    {
      onAudio: (frame) => chunks.push(frame.pcm),
      onSentenceEnd: () => settle(true),
      onSentenceError: () => settle(false),
      onClosed: () => settle(false),
    },
    choice,
  );
  if (!opened.ok) return null;
  const timer = setTimeout(() => settle(false), timeoutMs);
  try {
    opened.session.say("sample", text);
    if (!(await done)) return null;
  } finally {
    clearTimeout(timer);
    opened.session.close();
  }
  return wav(chunks, opened.session.format.sampleRate);
}

/** Mono signed 16-bit PCM in a WAV file. */
function wav(chunks: Uint8Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(44 + size);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + size, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, size, true);
  let at = 44;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

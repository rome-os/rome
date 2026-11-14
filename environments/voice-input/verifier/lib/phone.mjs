// Leg A of the iOS checks: plays a recording to Rome the way the iOS app does, over the voice
// input socket, with no phone. The contract it follows is the one the planner settled for the
// app: 16 kHz mono 16-bit PCM in 100 ms frames at real time after a `start`, then a `stop`, and
// the app gives up when no `alive` comes for 3 s.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readWav, resample } from "./compare.mjs";

// Rome's own WebSocket client, since the browser's API cannot send the sign-in cookie.
const WebSocket = createRequire(new URL("../../../../packages/core/package.json", import.meta.url))(
  "ws",
);

export const PHONE_RATE = 16000;
export const FRAME_MS = 100;
export const ALIVE_TIMEOUT_MS = 3000;

/**
 * Plays the WAV at `path` to the voice input socket of the instance at `origin`, signed in with
 * `cookies` (Playwright's shape), and resolves to
 * `{ text, samples, startedAt, endedAt, ended, error, aliveLapse }`. `samples` are `[ms, text]`
 * from the first frame, one per change; `aliveLapse` is true when the socket went 3 s without
 * `alive` while open, which is when the app would give up.
 */
export async function phoneDictate({
  origin,
  cookies,
  path,
  afterSpeechMs = 2000,
  endTimeoutMs = 20000,
}) {
  const { samples: raw, rate } = readWav(readFileSync(path));
  const pcm = resample(raw, rate, PHONE_RATE);
  const url = new URL("/ws/voice-input", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, {
    headers: {
      Origin: new URL(origin).origin,
      Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    },
  });
  const result = {
    text: "",
    samples: [],
    ended: false,
    error: null,
    aliveLapse: false,
    events: [],
  };
  let settled = "";
  let startedAt = null;
  let lastAlive = Date.now();
  const since = () => (startedAt === null ? 0 : Date.now() - startedAt);
  const done = new Promise((resolve) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      result.events.push([since(), event.type]);
      if (event.type === "alive") lastAlive = Date.now();
      if (event.type === "text") {
        // `settled` is new final text to append; `pending` replaces the previous guess.
        settled += event.settled ?? "";
        const now = settled + (event.pending ?? "");
        if (now !== result.text) {
          result.text = now;
          result.samples.push([since(), now]);
        }
      }
      if (event.type === "error") result.error = event.reason ?? "error";
      if (event.type === "ended") {
        result.ended = true;
        resolve();
      }
    });
    socket.on("close", () => resolve());
    socket.on("error", (error) => {
      result.error ??= error.message;
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const watchdog = setInterval(() => {
    if (Date.now() - lastAlive > ALIVE_TIMEOUT_MS) result.aliveLapse = true;
  }, 250);
  try {
    socket.send(JSON.stringify({ type: "start", sampleRate: PHONE_RATE }));
    startedAt = Date.now();
    lastAlive = Date.now();
    const step = (PHONE_RATE * FRAME_MS) / 1000;
    for (let i = 0; i < pcm.length && socket.readyState === WebSocket.OPEN; i += step) {
      const frame = Buffer.alloc(step * 2);
      const chunk = pcm.subarray(i, i + step);
      for (let j = 0; j < chunk.length; j++) frame.writeInt16LE(chunk[j], j * 2);
      socket.send(frame);
      const due = startedAt + ((i + step) / PHONE_RATE) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
    }
    await new Promise((r) => setTimeout(r, afterSpeechMs));
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
    await Promise.race([done, new Promise((r) => setTimeout(r, endTimeoutMs))]);
  } finally {
    clearInterval(watchdog);
    socket.close();
  }
  result.startedAt = startedAt;
  return result;
}

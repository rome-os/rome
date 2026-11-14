// One streaming session per transcription provider. Each takes 16 kHz mono
// PCM16 audio and reports the text so far as `final` (settled) plus `partial`
// (may still change). Audio passes straight through; nothing is kept.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url)),
);
const WebSocket = require("ws");

export const SAMPLE_RATE = 16000;

// Each vendor's own list price for streaming, in US dollars per hour of
// audio, read from the linked page on 2026-11-14. `priceNote` says what the
// number assumes when that matters.
export const PROVIDERS = [
  {
    id: "soniox",
    name: "Soniox",
    model: "stt-rt-v6",
    key: "SONIOX_API_KEY",
    pricePerHour: 0.12,
    priceSource: "https://soniox.com/pricing",
  },
  {
    id: "openai",
    name: "OpenAI",
    model: "gpt-live-transcribe",
    key: "OPENAI_API_KEY",
    pricePerHour: 1.02,
    priceSource: "https://developers.openai.com/api/docs/models/gpt-live-transcribe",
    priceNote: "$0.017 per minute",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    model: "scribe_v2_realtime",
    key: "ELEVENLABS_API_KEY",
    pricePerHour: 0.22,
    priceSource: "https://elevenlabs.io/pricing/api",
    priceNote: "base tier",
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    model: "universal-3-6-pro",
    key: "ASSEMBLYAI_API_KEY",
    pricePerHour: 0.45,
    priceSource: "https://www.assemblyai.com/pricing",
    priceNote: "billed while connected",
  },
];

// Opens a session with one provider. `events` gets text(final, partial),
// error(message) and closed(). Returns send(pcm) and stop(), where stop asks
// the provider for its last words and resolves once they arrive or 5 s pass.
export function openSession(provider, apiKey, events) {
  const open = { soniox, openai, elevenlabs, assemblyai }[provider.id];
  return open(provider, apiKey, events);
}

function connect(url, options, events) {
  const ws = new WebSocket(url, options);
  const queue = [];
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  ws.on("open", () => {
    for (const m of queue.splice(0)) ws.send(m);
  });
  ws.on("error", (e) => events.error(e.message));
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res
      .on("data", (d) => (body += d))
      .on("end", () => events.error(`HTTP ${res.statusCode} ${body.slice(0, 200)}`));
  });
  ws.on("close", () => {
    done();
    events.closed();
  });
  return {
    ws,
    finished,
    send(m) {
      if (ws.readyState === WebSocket.OPEN) ws.send(m);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(m);
    },
    async stopAfter(m) {
      this.send(m);
      await Promise.race([finished, new Promise((r) => setTimeout(r, 5000))]);
      ws.terminate();
    },
  };
}

function soniox(provider, apiKey, events) {
  const c = connect(
    "wss://stt-rt.soniox.com/transcribe-websocket",
    { headers: { Authorization: `Bearer ${apiKey}` } },
    events,
  );
  c.send(
    JSON.stringify({
      model: provider.model,
      audio_format: "pcm_s16le",
      sample_rate: SAMPLE_RATE,
      num_channels: 1,
      language_hints: ["en", "zh"],
    }),
  );
  let final = "";
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.error_code) return events.error(`${m.error_code} ${m.error_message}`);
    let partial = "";
    for (const t of m.tokens ?? []) {
      if (t.text === "<end>" || t.text === "<fin>") continue;
      if (t.is_final) final += t.text;
      else partial += t.text;
    }
    events.text(final, partial);
  });
  return { send: (pcm) => c.send(pcm), stop: () => c.stopAfter("") };
}

// OpenAI wants 24 kHz, so each 16 kHz chunk is resampled on the way through.
function openai(provider, apiKey, events) {
  const c = connect(
    "wss://api.openai.com/v1/realtime?intent=transcription",
    { headers: { Authorization: `Bearer ${apiKey}` } },
    events,
  );
  c.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: provider.model },
            turn_detection: null,
          },
        },
      },
    }),
  );
  const items = new Map();
  const report = () => events.text([...items.values()].join(""), "");
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === "error") return events.error(m.error?.message ?? "error");
    if (m.type === "conversation.item.input_audio_transcription.delta") {
      items.set(m.item_id, (items.get(m.item_id) ?? "") + m.delta);
      report();
    } else if (m.type === "conversation.item.input_audio_transcription.completed") {
      items.set(m.item_id, m.transcript);
      report();
      if (stopping) c.ws.close();
    } else if (m.type === "conversation.item.input_audio_transcription.failed") {
      events.error("transcription failed");
    }
  });
  let stopping = false;
  return {
    send: (pcm) =>
      c.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: resample16to24(pcm).toString("base64"),
        }),
      ),
    stop: () => {
      stopping = true;
      return c.stopAfter(JSON.stringify({ type: "input_audio_buffer.commit" }));
    },
  };
}

function elevenlabs(provider, apiKey, events) {
  const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${provider.model}&audio_format=pcm_16000&commit_strategy=vad`;
  const c = connect(url, { headers: { "xi-api-key": apiKey } }, events);
  let final = "";
  let stopping = false;
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.message_type === "partial_transcript") events.text(final, m.text);
    else if (m.message_type === "committed_transcript") {
      if (m.text) final += (final && !/^\s/.test(m.text) ? " " : "") + m.text;
      events.text(final, "");
      if (stopping) c.ws.close();
    } else if (m.error) events.error(`${m.message_type}: ${m.error}`);
  });
  const chunk = (pcm, commit) =>
    JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: pcm.toString("base64"),
      commit,
      sample_rate: SAMPLE_RATE,
    });
  return {
    send: (pcm) => c.send(chunk(pcm, false)),
    stop: () => {
      stopping = true;
      // 100 ms of silence carries the commit, so the last segment settles.
      return c.stopAfter(chunk(Buffer.alloc(SAMPLE_RATE / 5), true));
    },
  };
}

function assemblyai(provider, apiKey, events) {
  const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${SAMPLE_RATE}&encoding=pcm_s16le&speech_model=${provider.model}&language_detection=true`;
  const c = connect(url, { headers: { Authorization: apiKey } }, events);
  const turns = new Map();
  c.ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === "Turn") {
      turns.set(m.turn_order, { text: m.transcript, final: m.end_of_turn });
      const ordered = [...turns.entries()].sort(([a], [b]) => a - b).map(([, t]) => t);
      const final = ordered.filter((t) => t.final).map((t) => t.text);
      const partial = ordered.filter((t) => !t.final).map((t) => t.text);
      events.text(final.join(" "), partial.join(" "));
    } else if (m.type === "Termination") c.ws.close();
    else if (m.error) events.error(m.error);
  });
  return {
    send: (pcm) => c.send(pcm),
    stop: () => c.stopAfter(JSON.stringify({ type: "Terminate" })),
  };
}

// Linear interpolation from 16 kHz to 24 kHz PCM16, good enough for speech.
function resample16to24(pcm) {
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const out = new Int16Array(Math.floor((input.length * 3) / 2));
  for (let i = 0; i < out.length; i++) {
    const x = (i * 2) / 3;
    const j = Math.floor(x);
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (x - j));
  }
  return Buffer.from(out.buffer);
}

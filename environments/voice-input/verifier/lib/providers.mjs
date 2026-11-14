// Streaming clients for the transcription providers the comparison scores, written from each
// provider's API reference on 2026-11-14. None has run against the real service yet: no
// credential was available. Each streaming client is
//   connect({ key, language }) -> { send(Int16Array), end(), done: Promise<void> }
// and reports the whole transcript so far through `onText` each time it changes.

const wsOpen = (url, headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(new Error(e.message ?? "websocket error")), {
      once: true,
    });
  });

const base64 = (samples) =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");

/** Resolves when `ws` closes, rejects on a provider error message. */
function closed(ws, onError) {
  return new Promise((resolve, reject) => {
    ws.addEventListener("close", () => resolve());
    onError.reject = reject;
  });
}

const hints = (language) => (language === "en" ? ["en"] : ["zh", "en"]);

/** Soniox real-time WebSocket API: https://docs.soniox.com/stt/api-reference/websocket-api */
const soniox = {
  name: "Soniox stt-rt-v6",
  rate: 16000,
  keyVar: "SONIOX_API_KEY",
  pricePerHour: { usd: 0.12, source: "secondary sources, 2026-11-14; check soniox.com/pricing" },
  async connect({ key, language, onText }) {
    const ws = await wsOpen("wss://stt-rt.soniox.com/transcribe-websocket", {
      Authorization: `Bearer ${key}`,
    });
    ws.send(
      JSON.stringify({
        model: process.env.SONIOX_MODEL ?? "stt-rt-v6",
        audio_format: "pcm_s16le",
        sample_rate: 16000,
        num_channels: 1,
        language_hints: hints(language),
      }),
    );
    let final = "";
    const err = {};
    const done = closed(ws, err);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.error_code) return err.reject(new Error(`${msg.error_code} ${msg.error_message}`));
      let partial = "";
      for (const t of msg.tokens ?? []) {
        if (t.text === "<end>" || t.text === "<fin>") continue;
        if (t.is_final) final += t.text;
        else partial += t.text;
      }
      onText(final + partial);
      if (msg.finished) ws.close();
    });
    return { send: (s) => ws.send(s), end: () => ws.send(""), done };
  },
};

/** AssemblyAI v3 streaming: https://www.assemblyai.com/docs/api-reference/streaming-api */
const assemblyai = {
  name: "AssemblyAI universal-3-6-pro",
  rate: 16000,
  keyVar: "ASSEMBLYAI_API_KEY",
  pricePerHour: {
    usd: 0.45,
    source: "secondary sources, 2026-11-14; check assemblyai.com/pricing",
  },
  async connect({ key, language, onText }) {
    const params = new URLSearchParams({
      speech_model: "universal-3-6-pro",
      encoding: "pcm_s16le",
      sample_rate: "16000",
    });
    if (language !== "en") params.set("language_codes", "zh");
    const ws = await wsOpen(`wss://streaming.assemblyai.com/v3/ws?${params}`, {
      Authorization: key,
    });
    const turns = new Map();
    const err = {};
    const done = closed(ws, err);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "Turn") {
        turns.set(msg.turn_order, msg.transcript);
        onText(
          [...turns.keys()]
            .sort((a, b) => a - b)
            .map((k) => turns.get(k))
            .join(" "),
        );
      }
      if (msg.type === "Termination") ws.close();
      if (msg.error) err.reject(new Error(msg.error));
    });
    return {
      send: (s) => ws.send(s),
      end: () => ws.send(JSON.stringify({ type: "Terminate" })),
      done,
    };
  },
};

/** ElevenLabs Scribe realtime: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime */
const elevenlabs = {
  name: "ElevenLabs scribe_v2_realtime",
  rate: 16000,
  keyVar: "ELEVENLABS_API_KEY",
  pricePerHour: { usd: 0.39, source: "secondary sources, 2026-11-14; check elevenlabs.io/pricing" },
  async connect({ key, language, onText }) {
    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      audio_format: "pcm_16000",
      commit_strategy: "manual",
    });
    if (language === "en") params.set("language_code", "en");
    const ws = await wsOpen(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
      "xi-api-key": key,
    });
    let committed = "";
    let ending = false;
    const err = {};
    const done = closed(ws, err);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.message_type === "partial_transcript") onText(committed + msg.text);
      else if (msg.message_type === "committed_transcript") {
        committed += msg.text;
        onText(committed);
        if (ending) ws.close();
      } else if (msg.message_type?.includes("error")) err.reject(new Error(JSON.stringify(msg)));
    });
    const chunk = (s, commit) =>
      ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: base64(s),
          sample_rate: 16000,
          commit,
        }),
      );
    return {
      send: (s) => chunk(s, false),
      end: () => {
        ending = true;
        chunk(new Int16Array(0), true);
      },
      done,
    };
  },
};

/** OpenAI realtime transcription: https://developers.openai.com/api/docs/guides/realtime-transcription */
const openaiLive = {
  name: "OpenAI gpt-live-transcribe",
  rate: 24000,
  keyVar: "OPENAI_API_KEY",
  pricePerHour: {
    usd: 1.02,
    source: "$0.017 per minute, secondary sources, 2026-11-14; check openai.com/api/pricing",
  },
  async connect({ key, language, onText }) {
    const ws = await wsOpen("wss://api.openai.com/v1/realtime?intent=transcription", {
      Authorization: `Bearer ${key}`,
    });
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "gpt-live-transcribe", languages: hints(language) },
              turn_detection: null,
            },
          },
        },
      }),
    );
    let text = "";
    const err = {};
    const done = closed(ws, err);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "conversation.item.input_audio_transcription.delta") {
        text += msg.delta;
        onText(text);
      } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
        text = msg.transcript;
        onText(text);
        ws.close();
      } else if (msg.type === "error") err.reject(new Error(msg.error?.message ?? "error"));
    });
    return {
      send: (s) => ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64(s) })),
      end: () => ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })),
      done,
    };
  },
};

/**
 * OpenAI gpt-transcribe on a finished recording, the second pass after the guardian stops.
 * It has no stream, so it scores rule 3 only.
 */
const openaiFile = {
  name: "OpenAI gpt-transcribe (finished recording)",
  rate: 24000,
  keyVar: "OPENAI_API_KEY",
  file: true,
  pricePerHour: { usd: null, source: "no published price found on 2026-11-14" },
  async transcribe({ key, wav }) {
    const form = new FormData();
    form.set("model", "gpt-transcribe");
    form.set("file", new Blob([wav], { type: "audio/wav" }), "message.wav");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()).text;
  },
};

export const PROVIDERS = {
  soniox,
  elevenlabs,
  assemblyai,
  "openai-live": openaiLive,
  "openai-file": openaiFile,
};

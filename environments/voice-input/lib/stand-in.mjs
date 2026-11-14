// A stand-in for Soniox's real-time transcription, for the voice input
// environment. It speaks the same WebSocket protocol at
// ws://<host>:8790/transcribe-websocket and answers with text and timing the
// environment sets, or with an error, instead of listening to the audio.
//
// Control, on 8791 (JSON):
//   GET  /script   the current script
//   PUT  /script   {"mode":"text","text":"...","firstMs":400,"tokenMs":150}
//                  {"mode":"error","errorCode":503,"errorType":"...","afterMs":0}
//   GET  /stats    the sessions so far: their start request (key removed),
//                  how they authenticated, audio bytes received, how they ended
//   POST /reset    forget the sessions
//
// Audio is counted and dropped. Nothing about it is kept but its byte count.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const KEY = process.env.STAND_IN_API_KEY ?? "stand-in-key";
const WS_PORT = Number(process.env.STAND_IN_PORT ?? 8790);
const CONTROL_PORT = Number(process.env.STAND_IN_CONTROL_PORT ?? 8791);

const DEFAULT_SCRIPT = {
  mode: "text",
  text: "This is the stand-in transcriber speaking.",
  firstMs: 400,
  tokenMs: 150,
};
let script = { ...DEFAULT_SCRIPT };
let sessions = [];

// English splits into words with their leading space, Chinese into
// characters, the way Soniox's tokens come.
export function tokenize(text) {
  return text.match(/\s*[\p{Script=Han}\p{P}]|\s*[^\s\p{Script=Han}\p{P}]+/gu) ?? [];
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const control = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/script") return json(res, 200, script);
  if (req.method === "GET" && path === "/stats") return json(res, 200, { sessions });
  if (req.method === "POST" && path === "/reset") {
    sessions = [];
    script = { ...DEFAULT_SCRIPT };
    return json(res, 200, { ok: true });
  }
  if (req.method === "PUT" && path === "/script") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const next = JSON.parse(body);
      if (next.mode !== "text" && next.mode !== "error") throw new Error("mode is text or error");
      script =
        next.mode === "text"
          ? { ...DEFAULT_SCRIPT, ...next }
          : { errorCode: 503, errorType: "service_unavailable", afterMs: 0, ...next };
      return json(res, 200, script);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  json(res, 404, { error: "not found" });
});

const http = createServer((_req, res) => json(res, 404, { error: "not found" }));
const wss = new WebSocketServer({ server: http, path: "/transcribe-websocket" });

wss.on("connection", (ws, req) => {
  const session = {
    startedAt: new Date().toISOString(),
    auth: null,
    start: null,
    audioBytes: 0,
    audioFrames: 0,
    tokensSent: 0,
    ended: null,
  };
  sessions.push(session);
  const plan = { ...script };
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const protocolKey = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
  let firstAudioAt = 0;
  const timers = [];
  let released = 0;
  const tokens = plan.mode === "text" ? tokenize(plan.text) : [];
  let finished = false;

  const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const procMs = () => (session.audioBytes / 2 / (session.start?.sample_rate ?? 16000)) * 1000;
  const fail = (code, type, message) => {
    session.ended = `error ${code}`;
    send({
      tokens: [],
      error_code: code,
      error_type: type,
      error_message: message,
      request_id: "stand-in",
    });
    ws.close(1000);
  };
  // Releases token i: the ones before the last two settle as final, the
  // last two stay open, as a streaming provider revises its latest words.
  const release = (count, allFinal) => {
    released = Math.max(released, count);
    const settled = allFinal ? released : Math.max(0, released - 2);
    const out = [];
    for (let i = session.tokensSent; i < settled; i++)
      out.push({ text: tokens[i], is_final: true, confidence: 0.99 });
    for (let i = settled; i < released; i++)
      out.push({ text: tokens[i], is_final: false, confidence: 0.9 });
    session.tokensSent = settled;
    send({
      tokens: out,
      final_audio_proc_ms: Math.round(procMs()),
      total_audio_proc_ms: Math.round(procMs()),
    });
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimeout(t);
    if (plan.mode === "text") release(tokens.length, true);
    send({
      tokens: [],
      final_audio_proc_ms: Math.round(procMs()),
      total_audio_proc_ms: Math.round(procMs()),
      finished: true,
    });
    session.ended ??= "finished";
    ws.close(1000);
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!session.start)
        return fail(400, "invalid_request", "Audio sent before the start request.");
      session.audioBytes += data.length;
      session.audioFrames += 1;
      if (!firstAudioAt) {
        firstAudioAt = Date.now();
        if (plan.mode === "error") {
          timers.push(
            setTimeout(
              () => fail(plan.errorCode, plan.errorType, plan.errorMessage ?? "Stand-in error."),
              plan.afterMs,
            ),
          );
        } else {
          tokens.forEach((_, i) =>
            timers.push(setTimeout(() => release(i + 1, false), plan.firstMs + i * plan.tokenMs)),
          );
        }
      }
      return;
    }
    const text = data.toString();
    if (text === "") return finish();
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return fail(400, "invalid_request", "Text frames are JSON.");
    }
    if (!session.start) {
      const { api_key, ...rest } = m;
      const ways = [
        bearer && "bearer",
        api_key && "api_key",
        protocolKey.includes(KEY) && "protocol",
      ].filter(Boolean);
      session.auth = ways;
      if (![bearer, api_key].includes(KEY) && !protocolKey.includes(KEY)) {
        return fail(401, "unauthenticated", "Incorrect API key provided.");
      }
      if (!rest.model || !rest.audio_format)
        return fail(400, "invalid_request", "model and audio_format are required.");
      session.start = rest;
      return;
    }
    if (m.type === "keepalive") return;
    if (m.type === "finalize") {
      if (plan.mode === "text") release(released, true);
      return send({
        tokens: [{ text: "<fin>", is_final: true }],
        final_audio_proc_ms: Math.round(procMs()),
        total_audio_proc_ms: Math.round(procMs()),
      });
    }
    fail(400, "invalid_request", `Unknown control type ${m.type}.`);
  });
  ws.on("close", () => {
    for (const t of timers) clearTimeout(t);
    session.ended ??= "closed by client";
  });
});

http.listen(WS_PORT, "0.0.0.0");
control.listen(CONTROL_PORT, "0.0.0.0");
console.log(
  `stand-in transcriber on :${WS_PORT}/transcribe-websocket, control on :${CONTROL_PORT}`,
);

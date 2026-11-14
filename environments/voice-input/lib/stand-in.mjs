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
//   PUT  /keys     {"mintedOnly":true} accepts only temporary keys it minted;
//                  {"sessionCapSeconds":5} ends every temporary key's session
//                  that long after it starts, sooner than its own cap (null: off)
//   POST /reset    forget the sessions and the temporary keys
//
// Like Soniox, it mints temporary keys on its WebSocket port:
//   POST /v1/auth/temporary-api-key   Bearer <long-lived key>
//        {"usage_type":"transcribe_websocket","expires_in_seconds":60,
//         "client_reference_id":"...","single_use":true,
//         "max_session_duration_seconds":1800}  ->  201 {"api_key","expires_at"}
// A single-use key opens one session. A session on a key with a duration cap
// ends with the error temp_api_key_session_expired when the cap is reached.
// With STAND_IN_MINTED_ONLY=1, or after PUT /keys, a session must
// authenticate with a temporary key, which is what Rome gets from Rome Cloud.
// Otherwise the long-lived key works too, as a Rome with its own credential
// uses it.
//
// Audio is counted and dropped. Nothing about it is kept but its byte count.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const KEY = process.env.STAND_IN_API_KEY ?? "stand-in-key";
let mintedOnly = process.env.STAND_IN_MINTED_ONLY === "1";
let sessionCapSeconds = null;
// Temporary key -> {expiresAt (ms), clientReferenceId, singleUse, used, maxSessionSeconds}
const minted = new Map();
let mints = [];
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
  if (req.method === "GET" && path === "/stats")
    return json(res, 200, { mintedOnly, sessionCapSeconds, mints, sessions });
  if (req.method === "POST" && path === "/reset") {
    sessions = [];
    mints = [];
    minted.clear();
    script = { ...DEFAULT_SCRIPT };
    return json(res, 200, { ok: true });
  }
  if (req.method === "PUT" && path === "/keys") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const next = JSON.parse(body);
      if ("mintedOnly" in next) {
        if (typeof next.mintedOnly !== "boolean") throw new Error("mintedOnly is true or false");
        mintedOnly = next.mintedOnly;
      }
      if ("sessionCapSeconds" in next) {
        const cap = next.sessionCapSeconds;
        if (cap !== null && !(Number.isFinite(cap) && cap > 0))
          throw new Error("sessionCapSeconds is a positive number or null");
        sessionCapSeconds = cap;
      }
      return json(res, 200, { mintedOnly, sessionCapSeconds });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
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

// Soniox's error body for its REST API.
function apiError(res, status, type, message) {
  json(res, status, { status_code: status, error_type: type, message, request_id: "stand-in" });
}

async function mintTemporaryKey(req, res) {
  const record = { at: new Date().toISOString(), status: 0, clientReferenceId: null };
  mints.push(record);
  const done = (status, ...rest) => {
    record.status = status;
    return apiError(res, status, ...rest);
  };
  if (/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] !== KEY)
    return done(401, "unauthenticated", "Incorrect API key provided.");
  let body = "";
  for await (const chunk of req) body += chunk;
  let m;
  try {
    m = JSON.parse(body);
  } catch {
    return done(400, "invalid_request", "Body is JSON.");
  }
  const seconds = m.expires_in_seconds;
  if (m.usage_type !== "transcribe_websocket")
    return done(400, "invalid_request", "usage_type is transcribe_websocket.");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    return done(400, "invalid_request", "expires_in_seconds is an integer from 1 to 3600.");
  if (m.client_reference_id != null && String(m.client_reference_id).length > 256)
    return done(400, "invalid_request", "client_reference_id is at most 256 characters.");
  if (m.single_use != null && typeof m.single_use !== "boolean")
    return done(400, "invalid_request", "single_use is a boolean.");
  const max = m.max_session_duration_seconds;
  if (max != null && (!Number.isInteger(max) || max < 1 || max > 18000))
    return done(
      400,
      "invalid_request",
      "max_session_duration_seconds is an integer from 1 to 18000.",
    );
  const apiKey = `temp:${randomBytes(24).toString("base64url")}`;
  const expiresAt = Date.now() + seconds * 1000;
  const key = {
    expiresAt,
    clientReferenceId: m.client_reference_id ?? null,
    singleUse: m.single_use === true,
    used: false,
    maxSessionSeconds: max ?? null,
  };
  minted.set(apiKey, key);
  Object.assign(record, {
    status: 201,
    clientReferenceId: key.clientReferenceId,
    expiresInSeconds: seconds,
    singleUse: key.singleUse,
    maxSessionSeconds: key.maxSessionSeconds,
  });
  json(res, 201, { api_key: apiKey, expires_at: new Date(expiresAt).toISOString() });
}

// Which kind of key this is, or null when the stand-in does not accept it.
function keyKind(key) {
  if (!key) return null;
  if (key === KEY) return mintedOnly ? null : "long-lived";
  const temp = minted.get(key);
  if (!temp || (temp.singleUse && temp.used)) return null;
  return temp.expiresAt > Date.now() ? "temporary" : null;
}

const http = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && path === "/v1/auth/temporary-api-key")
    return mintTemporaryKey(req, res);
  json(res, 404, { error: "not found" });
});
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
    if (session.ended) return;
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
      const offered = [
        ["bearer", bearer],
        ["api_key", api_key],
        ...protocolKey.map((p) => ["protocol", p]),
      ].filter(([, k]) => k);
      const accepted = offered.find(([, k]) => keyKind(k));
      session.auth = offered.filter(([, k]) => keyKind(k)).map(([way]) => way);
      if (!accepted) return fail(401, "unauthenticated", "Incorrect API key provided.");
      session.keyKind = keyKind(accepted[1]);
      if (session.keyKind === "temporary") {
        const temp = minted.get(accepted[1]);
        temp.used = true;
        session.clientReferenceId = temp.clientReferenceId;
        const caps = [temp.maxSessionSeconds, sessionCapSeconds].filter((c) => c != null);
        if (caps.length) {
          session.capSeconds = Math.min(...caps);
          timers.push(
            setTimeout(
              () =>
                fail(
                  408,
                  "temp_api_key_session_expired",
                  "Temporary API key session expired (max_session_duration_seconds reached).",
                ),
              session.capSeconds * 1000,
            ),
          );
        }
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

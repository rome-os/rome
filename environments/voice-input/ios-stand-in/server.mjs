// The stand-in instance for the iOS UI tests on CI's macOS runner. It answers
// the iOS app's routes with what record.mjs recorded from the environment's
// real Rome, keeps the messages typed into it, and speaks the real
// `/ws/events` and `/ws/voice-input` protocols. It is not Rome: a check it
// scores says "stand-in instance". Node only, no packages.
//
//   node server.mjs [--port 4790] [--log <file>] [--transcript <text>]
//     [--voice-error <reason> [--voice-error-after-ms <n>]]
//
// Control (not part of Rome's API):
//   GET  /__stand-in/health
//   POST /__stand-in/voice   {transcript?, error?: {reason, detail?, afterMs?} | null}
//   GET  /__stand-in/stats   {requests, unrecorded, voiceSessions}
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const PORT = Number(args.port ?? 4790);
const http = JSON.parse(readFileSync(resolve(here, "fixtures/http.json"), "utf8"));
const events = JSON.parse(readFileSync(resolve(here, "fixtures/events.json"), "utf8"));

const SAMPLE_RATE = 16_000;
const ALIVE_MS = 1_000;
const NO_SPEECH_MS = 30_000;
// Below this RMS of 16-bit samples a frame counts as silence.
const SILENCE_RMS = 300;

const voice = {
  transcript: args.transcript ?? "Remind me to call the dentist tomorrow at 9 in the morning.",
  error: args["voice-error"]
    ? { reason: args["voice-error"], afterMs: Number(args["voice-error-after-ms"] ?? 0) }
    : null,
};
const stats = { requests: 0, unrecorded: [], voiceSessions: [] };

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  if (args.log) appendFileSync(args.log, `${text}\n`);
  else console.log(text);
}

// --- HTTP from the fixtures ------------------------------------------------

const SESSION_COOKIE = "stand-in-session";
const cookieName = http.cookieNames?.[0] ?? "rome_session";
const byKey = new Map();
const byPath = new Map();
// The recording runs in order, so a route recorded twice answers as it did
// last: after the task started, with its card and thread in the main Chat.
for (const e of http.entries) {
  const query = new URLSearchParams([...new URLSearchParams(e.query)].sort()).toString();
  byKey.set(`${e.method} ${e.path}?${query}`, e);
  byPath.set(`${e.method} ${e.path}`, e);
}

// Messages typed into the stand-in, per session: each a copy of the recorded
// sent message with the new text and a new id.
const typed = new Map();
const sent = events.send;

function replaceDeep(value, from, to) {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, from, to));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, from, to)]));
  return value;
}
// The guardian message the recorded send added.
const sentMessage =
  (sent.messages ?? []).find((m) => m.id && JSON.stringify(m).includes(sent.text)) ?? null;

function typedCopy(text) {
  if (!sentMessage) return null;
  return replaceDeep(replaceDeep(sentMessage, sent.text, text), sentMessage.id, randomUUID());
}

function messagesPage(sessionId, base) {
  const extra = typed.get(sessionId) ?? [];
  if (!extra.length || !base?.messages) return base;
  return { ...base, messages: [...base.messages, ...extra] };
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "x-rome-stand-in": "1" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch {
        ok({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  stats.requests += 1;
  const url = new URL(req.url, "http://stand-in");
  const path = url.pathname;
  const query = new URLSearchParams([...url.searchParams].sort()).toString();
  log(`${req.method} ${path}${query ? `?${query}` : ""}`);

  if (path === "/__stand-in/health") return send(res, 200, { ok: true, standIn: true });
  if (path === "/__stand-in/stats") return send(res, 200, stats);
  if (path === "/__stand-in/voice" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.transcript === "string") voice.transcript = body.transcript;
    if ("error" in body) voice.error = body.error;
    return send(res, 200, voice);
  }

  if (req.method === "POST" && path === "/api/auth/login") {
    const body = await readBody(req);
    if (body.password !== "stand-in") return send(res, 401, { error: "Invalid credentials" });
    res.setHeader("set-cookie", `${cookieName}=${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
  }

  // A typed send: the recorded answer, the recorded live events with the new
  // text, and the message kept for the next history load.
  const turn = /^\/api\/chat\/sessions\/([^/]+)\/turns$/.exec(path);
  if (req.method === "POST" && turn) {
    const body = await readBody(req);
    const message = typedCopy(body.text ?? "");
    if (message) {
      const list = typed.get(turn[1]) ?? [];
      list.push(message);
      typed.set(turn[1], list);
    }
    setTimeout(() => {
      for (const frame of sent.frames) {
        if (frame.type !== "event") continue;
        const sessionTopic = `chat.session:${turn[1]}`;
        let out = replaceDeep(frame, sent.text, body.text ?? "");
        if (message) out = replaceDeep(out, sentMessage.id, message.id);
        out = replaceDeep(out, `chat.session:${sent.sessionId}`, sessionTopic);
        broadcast(out);
      }
    }, 200);
    const recorded =
      byPath.get(`POST ${path}`) ?? byPath.get(`POST /api/chat/sessions/${sent.sessionId}/turns`);
    return send(res, recorded?.status ?? 200, recorded?.body ?? sent.turn ?? {});
  }

  const entry = byKey.get(`${req.method} ${path}?${query}`) ?? byPath.get(`${req.method} ${path}`);
  if (!entry) {
    stats.unrecorded.push(`${req.method} ${path}`);
    log(`unrecorded: ${req.method} ${path}`);
    return send(res, 404, { error: "unrecorded", standIn: true, route: `${req.method} ${path}` });
  }
  let body = entry.body ?? entry.text;
  const history = /^\/api\/chat\/sessions\/([^/]+)\/messages$/.exec(path);
  if (history && req.method === "GET" && !url.searchParams.has("before"))
    body = messagesPage(history[1], body);
  if (path === "/api/build-info" && body && typeof body === "object")
    body = { ...body, standIn: "stand-in instance" };
  // The transcriber here is this stand-in's own socket, whatever the recording
  // was transcribed by.
  if (path === "/api/voice-input" && body?.available)
    body = { ...body, place: { provider: "stand-in instance", host: `127.0.0.1:${PORT}` } };
  send(res, entry.status, body, entry.contentType);
});

// --- WebSockets, by hand ---------------------------------------------------

function accept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const digest = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\nx-rome-stand-in: 1\r\n\r\n`,
  );
}

function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (data.length < 126) head = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, data]);
}

// Calls onMessage(opcode, payload) for each whole message from the client.
function reader(socket, onMessage) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let partOpcode = 0;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const opcode = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      const maskAt = at;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)];
      buf = buf.subarray(at + len);
      if (opcode === 0x8) {
        socket.end(frame(0x8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0) partOpcode = opcode;
      parts.push(payload);
      if (fin) {
        onMessage(partOpcode, Buffer.concat(parts));
        parts = [];
      }
    }
  });
}

const eventSockets = new Map();
function broadcast(message) {
  for (const [socket, topics] of eventSockets) {
    if (topics.has(message.topic)) socket.write(frame(0x1, JSON.stringify(message)));
  }
}

function serveEvents(socket) {
  const topics = new Set();
  eventSockets.set(socket, topics);
  socket.on("close", () => eventSockets.delete(socket));
  socket.on("error", () => eventSockets.delete(socket));
  reader(socket, (opcode, payload) => {
    if (opcode !== 0x1) return;
    let m;
    try {
      m = JSON.parse(String(payload));
    } catch {
      return;
    }
    if (m.type === "subscribe" && typeof m.topic === "string") {
      topics.add(m.topic);
      socket.write(frame(0x1, JSON.stringify({ type: "subscribed", topic: m.topic })));
    } else if (m.type === "unsubscribe") topics.delete(m.topic);
  });
}

// One dictation, in the protocol of Rome's voice-input-server.ts.
function serveVoice(socket) {
  const record = {
    startedAt: new Date().toISOString(),
    sampleRate: null,
    bytes: 0,
    frames: 0,
    end: null,
  };
  stats.voiceSessions.push(record);
  const words = voice.transcript.split(/(?<=\s)/);
  const error = voice.error;
  let started = false;
  let sentWords = 0;
  let audioMs = 0;
  let silentMs = 0;
  let closed = false;
  const timers = [];
  const out = (m) => !closed && socket.write(frame(0x1, JSON.stringify(m)));
  const finish = (last) => {
    if (closed) return;
    out(last);
    record.end = last.type === "error" ? last.reason : "ended";
    closed = true;
    for (const t of timers) clearTimeout(t), clearInterval(t);
    socket.end(frame(0x8, Buffer.alloc(0)));
  };
  timers.push(setInterval(() => out({ type: "alive" }), ALIVE_MS));
  socket.on("close", () => {
    closed = true;
    for (const t of timers) clearTimeout(t), clearInterval(t);
  });
  socket.on("error", () => {});
  reader(socket, (opcode, payload) => {
    if (closed) return;
    if (opcode === 0x1) {
      let m;
      try {
        m = JSON.parse(String(payload));
      } catch {
        return finish({ type: "error", reason: "bad-request" });
      }
      if (m.type === "start" && !started) {
        started = true;
        record.sampleRate = m.sampleRate;
        if (m.sampleRate !== SAMPLE_RATE) return finish({ type: "error", reason: "bad-request" });
        if (error)
          timers.push(
            setTimeout(
              () =>
                finish({
                  type: "error",
                  reason: error.reason,
                  ...(error.detail ? { detail: error.detail } : {}),
                }),
              error.afterMs ?? 0,
            ),
          );
      } else if (m.type === "stop") {
        // The rest of the text, then the end.
        if (sentWords < words.length)
          out({ type: "text", settled: words.slice(sentWords).join(""), pending: "" });
        sentWords = words.length;
        timers.push(setTimeout(() => finish({ type: "ended" }), 150));
      } else if (!started) finish({ type: "error", reason: "bad-request" });
      return;
    }
    if (opcode !== 0x2 || !started) return;
    record.frames += 1;
    record.bytes += payload.length;
    const ms = (payload.length / 2 / SAMPLE_RATE) * 1000;
    audioMs += ms;
    let sum = 0;
    for (let i = 0; i + 1 < payload.length; i += 2) sum += payload.readInt16LE(i) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, payload.length / 2));
    silentMs = rms < SILENCE_RMS ? silentMs + ms : 0;
    if (silentMs >= NO_SPEECH_MS) return finish({ type: "error", reason: "no-speech" });
    // A word settles every 300 ms of audio, and the next shows as pending.
    const due = Math.min(words.length, Math.floor(audioMs / 300));
    if (due > sentWords) {
      out({
        type: "text",
        settled: words.slice(sentWords, due).join(""),
        pending: words[due] ?? "",
      });
      sentWords = due;
    }
  });
}

server.on("upgrade", (req, socket) => {
  const path = new URL(req.url, "http://stand-in").pathname;
  const signedIn = (req.headers.cookie ?? "").includes(`${cookieName}=${SESSION_COOKIE}`);
  log(`UPGRADE ${path}${signedIn ? "" : " (no session)"}`);
  if (!signedIn) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nx-rome-stand-in: 1\r\n\r\n");
    return;
  }
  if (path === "/ws/events") {
    accept(req, socket);
    serveEvents(socket);
  } else if (path === "/ws/voice-input") {
    accept(req, socket);
    serveVoice(socket);
  } else {
    stats.unrecorded.push(`UPGRADE ${path}`);
    log(`unrecorded: UPGRADE ${path}`);
    socket.end("HTTP/1.1 404 Not Found\r\nx-rome-stand-in: 1\r\n\r\n");
  }
});

server.listen(PORT, "127.0.0.1", () => log(`stand-in instance on 127.0.0.1:${PORT}`));

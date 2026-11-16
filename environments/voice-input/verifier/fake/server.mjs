// The stand-in product: a chat page with a message field and a voice control that follows
// the contract in rules-V2.md, and the bits of Rome the verifier reads. It hears nothing: the
// transcript of each recording is scheduled from the script's word times.
//
// Variants: `good` passes every phase 1 rule. Each `fail-<rule>` breaks that rule alone:
//   fail-2   text appears only when listening stops
//   fail-3   every fourth word or character comes out wrong
//   fail-5   a copy of the field sends itself when listening stops
//   fail-6   the transcript replaces the field instead of going in at the cursor
//   fail-10  the server sends the audio to a host Rome does not name
//   fail-11  Rome Cloud records half the seconds listened
//   fail-11g Rome Cloud mints a credential for an account the gate refuses
//   fail-11s an instance not signed in offers voice input on its own provider settings
//   fail-4   the transcript stops 90 seconds, or two thirds, into a listening session
//   fail-7   a stop other than the guardian's loses the words and says nothing
//   fail-8   with the microphone refused the control disappears, the first use gives no
//            reason, and Enter sends nothing
//   fail-1   the field shows listening, and idle again, 800 ms after the action
//   fail-9   the microphone stays open after listening stops, and silence never stops it
//   fail-12  listening uses the browser's default microphone, whichever one Settings chose
//   fail-13  Enter while listening sends at once, without the words still arriving
//   fail-14  the sign of hearing pulses on its own, in silence too
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { readState, updateState } from "./state.mjs";

export const VARIANTS = [
  "good",
  "fail-2",
  "fail-3",
  "fail-5",
  "fail-6",
  "fail-10",
  "fail-11",
  "fail-11g",
  "fail-4",
  "fail-7",
  "fail-8",
  "fail-9",
  "fail-1",
  "fail-12",
  "fail-13",
  "fail-14",
];

// Rome's own WebSocket server, for the voice input socket the iOS app speaks.
const { WebSocketServer } = createRequire(
  new URL("../../../../packages/core/package.json", import.meta.url),
)("ws");

/** The dashboard's chats; the page opens on the first. */
const CHATS = ["c1", "c2"];

/** The words the stand-in product shows in its `role="status"` element, in English and Chinese. */
const NOTICES = {
  en: {
    reason: "Rome uses the microphone to turn your speech into text",
    blocked: "Microphone blocked. Allow it in the browser's site settings",
    left: "Listening stopped when you left this chat",
    reloaded: "Listening stopped when the page reloaded",
    lost: "Connection to Rome lost. Listening stopped",
    silence: "Listening stopped after 30 seconds without speech",
    error: "Voice input failed. Listening stopped",
    start: "Start voice input",
    stop: "Stop voice input",
  },
  zh: {
    reason: "Rome 使用麦克风将你的语音转成文字",
    blocked: "麦克风已被阻止。请在浏览器的网站设置中允许",
    left: "离开此聊天时已停止收听",
    reloaded: "页面重新加载时已停止收听",
    lost: "与 Rome 的连接已断开，已停止收听",
    silence: "30 秒未检测到语音，已停止收听",
    error: "语音输入失败，已停止收听",
    start: "开始语音输入",
    stop: "停止语音输入",
  },
};

const PLACE = { provider: "Soniox", host: "stt-rt.soniox.com" };

/** Whether the instance offers voice input: signed in and allowed, or fail-11s on its own settings. */
function voiceOffered(state) {
  if (!state.cloud.signedIn) return state.variant === "fail-11s" && state.cloud.ownCredential;
  return state.cloud.gate;
}

/** Starts the stand-in on a free port. Resolves to `{ url, close }`. */
export async function startStandIn({ statePath, script }) {
  const server = createServer((req, res) => handle(req, res, statePath, script));
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://stand-in").pathname !== "/ws/voice-input") return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => voiceSocket(ws, statePath, script));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function handle(req, res, statePath, script) {
  const url = new URL(req.url, "http://stand-in");
  const state = readState(statePath);
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  if (state.networkCut) {
    req.socket.destroy();
    return;
  }
  const chatPath = url.pathname.match(/^\/chat\/([^/]+)$/);
  const rootPaths = ["/", "/chat", "/message"];
  if (req.method === "GET" && (rootPaths.includes(url.pathname) || chatPath))
    return send(
      200,
      "text/html; charset=utf-8",
      page(state.variant, voiceOffered(state), chatPath?.[1] ?? CHATS[0], state.lang),
    );
  if (req.method === "GET" && url.pathname === "/settings")
    return send(
      200,
      "text/html; charset=utf-8",
      `<main><h1>Settings</h1><p>Voice input: ${PLACE.provider}, ${PLACE.host}</p>
<label id="lang">Language</label>
<button role="combobox" aria-labelledby="lang">${state.lang === "zh" ? "中文" : "English"}</button>
<div role="listbox" hidden><div role="option" data-lang="en">English</div><div role="option" data-lang="zh">中文</div></div>
<label>Microphone <select id="mic"></select></label>
<script>
// The microphone choice lives in this browser, as the dashboard keeps it.
const mic = document.getElementById("mic");
navigator.mediaDevices.enumerateDevices().then((devices) => {
  for (const d of devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default")) {
    const o = new Option(d.label, d.deviceId);
    o.selected = d.deviceId === localStorage.getItem("voice-mic");
    mic.append(o);
  }
});
mic.onchange = () => localStorage.setItem("voice-mic", mic.value);
const box = document.querySelector("[role=listbox]");
document.querySelector("[role=combobox]").onclick = () => (box.hidden = false);
for (const o of box.children)
  o.onclick = () => fetch("/api/settings/lang", { method: "POST", body: o.dataset.lang });
</script></main>`,
    );
  if (req.method === "POST" && url.pathname === "/api/settings/lang") {
    const lang = await readBody(req);
    updateState(statePath, (s) => {
      s.lang = lang;
    });
    return send(204, "text/plain", "");
  }
  if (req.method === "GET" && url.pathname === "/api/voice-input")
    return send(
      200,
      "application/json",
      JSON.stringify(
        voiceOffered(state)
          ? { available: true, via: "rome-cloud", place: PLACE }
          : { available: false, via: null, place: null },
      ),
    );
  const post = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (req.method === "POST" && post) {
    const body = JSON.parse(await readBody(req));
    updateState(statePath, (s) => {
      s.chats[post[1]] ??= [];
      s.chats[post[1]].push({
        id: `m${s.nextId++}`,
        text: body.text,
        attachments: body.attachments,
      });
    });
    return send(201, "application/json", "{}");
  }
  if (req.method === "POST" && url.pathname === "/api/voice/usage") {
    const { seconds } = JSON.parse(await readBody(req));
    updateState(statePath, (s) => {
      const sessionId = crypto.randomUUID();
      s.cloud.usage.push({
        eventId: sessionId,
        sessionId,
        provider: "soniox",
        model: "stt-rt-v6",
        seconds: s.variant === "fail-11" ? seconds / 2 : seconds,
        at: new Date().toISOString(),
      });
      s.logs ??= [];
      s.logs.push({ message: "voice input stopped", data: { sessionId, outcome: "ended" } });
    });
    return send(204, "text/plain", "");
  }
  if (req.method === "GET" && url.pathname === "/api/voice/listen")
    return listen(req, res, statePath, script);
  send(404, "text/plain", "not found");
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

/** Streams the cumulative transcript as server-sent events, on the recording's word times. */
function listen(req, res, statePath, script) {
  const state = updateState(statePath, (s) => {
    if (!s.capturing) return;
    s.captured.push({
      side: "browser",
      to: `${req.headers.host}/api/voice/listen`,
      host: req.headers.host,
    });
    const host = s.variant === "fail-10" ? "api.elsewhere.example" : PLACE.host;
    s.captured.push({ side: "server", to: host, host });
  });
  const message = [...script.messages, ...(script.longs ?? [])].find(
    (m) => basename(m.path) === basename(state.mic ?? ""),
  );
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  // A recording outside the script, such as rule 14's tones, gets no words and stays open.
  if (!message) {
    req.on("close", () => res.end());
    return;
  }
  // The page stops listening on its own this long after the last word, as 30 s of silence would.
  const quiet = message.lastWordAt + (state.silenceSeconds ?? 30);
  res.write(`event: silence\ndata: ${JSON.stringify(quiet)}\n\n`);
  const text = state.transcriber.mode === "real" ? message.text : state.transcriber.text;
  const pieces = split(state.variant === "fail-3" ? garble(text) : text);
  const first = message.firstWordAt + 0.3;
  const last = message.lastWordAt + 0.4;
  const timers = pieces.map((_, i) => {
    const at = pieces.length === 1 ? last : first + ((last - first) * i) / (pieces.length - 1);
    if (state.variant === "fail-4" && (at > 90 || i > (pieces.length * 2) / 3)) return null;
    return setTimeout(() => {
      res.write(`data: ${JSON.stringify(pieces.slice(0, i + 1).join(""))}\n\n`);
    }, at * 1000);
  });
  // The transcriber has sent every word of the recording.
  timers.push(setTimeout(() => res.write("event: done\ndata: null\n\n"), last * 1000 + 50));
  const { error } = state.transcriber;
  if (state.transcriber.mode === "stand-in" && error)
    timers.push(
      setTimeout(
        () => {
          res.write(`event: failure\ndata: ${JSON.stringify(error)}\n\n`);
          res.end();
        },
        (first + (state.transcriber.afterMs ?? 2000) / 1000) * 1000,
      ),
    );
  // A cut network drops the open stream, as it drops Rome's websocket.
  // A cut route to the provider ends the session with an error, as Rome reports one.
  const watch = setInterval(() => {
    const now = readState(statePath);
    if (now.networkCut) res.destroy();
    else if (now.routeCut && !res.writableEnded) {
      res.write(`event: failure\ndata: "route"\n\n`);
      res.end();
      updateState(statePath, (s) => {
        s.routeClosed = (s.routeClosed ?? 0) + 1;
      });
    }
  }, 100);
  req.on("close", () => {
    clearInterval(watch);
    timers.forEach((t) => t && clearTimeout(t));
  });
}

/**
 * The voice input socket the iOS app speaks: `start`, PCM frames, `stop`; answers `text`
 * (`settled` appended, `pending` replaced), `alive` every second, then `ended` and a usage
 * event for the seconds of audio it got. Words follow the recording's times from `start`, and
 * the variants break it as they break the dashboard.
 */
function voiceSocket(ws, statePath, script) {
  const state = readState(statePath);
  const out = (event) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(event));
  if (!voiceOffered(state)) {
    out({ type: "error", reason: "service-refused" });
    return ws.close();
  }
  updateState(statePath, (s) => {
    if (!s.capturing) return;
    const host = s.variant === "fail-10" ? "api.elsewhere.example" : PLACE.host;
    s.captured.push({ side: "server", to: host, host });
  });
  const message = [...script.messages, ...(script.longs ?? [])].find(
    (m) => basename(m.path) === basename(state.mic ?? ""),
  );
  const text = !message
    ? ""
    : state.transcriber.mode === "real"
      ? message.text
      : state.transcriber.text;
  const pieces = split(state.variant === "fail-3" ? garble(text) : text) ?? [];
  let sent = 0;
  let bytes = 0;
  const timers = [setInterval(() => out({ type: "alive" }), 1000)];
  const settle = (upTo) => {
    if (upTo <= sent) return;
    out({ type: "text", settled: pieces.slice(sent, upTo).join(""), pending: "" });
    sent = upTo;
  };
  // Rome ends a session after this long without speech, as real Rome does with `no-speech`.
  const quietLimitMs = (state.silenceSeconds ?? 30) * 1000;
  let quietMs = 0;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      bytes += data.length;
      let sum = 0;
      for (let i = 0; i + 1 < data.length; i += 2) sum += data.readInt16LE(i) ** 2;
      const silent = Math.sqrt(sum / Math.max(1, data.length / 2)) < 300;
      quietMs = silent ? quietMs + (data.length / 32000) * 1000 : 0;
      if (quietMs >= quietLimitMs && state.variant !== "fail-9") {
        out({ type: "error", reason: "no-speech" });
        ws.close();
      }
      return;
    }
    const m = JSON.parse(String(data));
    if (m.type === "start" && message) {
      const first = message.firstWordAt + 0.3;
      const last = message.lastWordAt + 0.4;
      pieces.forEach((_, i) => {
        const at = pieces.length === 1 ? last : first + ((last - first) * i) / (pieces.length - 1);
        if (state.variant === "fail-2") return;
        if (state.variant === "fail-4" && (at > 90 || i > (pieces.length * 2) / 3)) return;
        timers.push(setTimeout(() => settle(i + 1), at * 1000));
      });
    } else if (m.type === "stop") {
      if (state.variant === "fail-2") settle(pieces.length);
      const seconds = bytes / 32000;
      updateState(statePath, (s) => {
        const sessionId = crypto.randomUUID();
        s.cloud.usage.push({
          eventId: sessionId,
          sessionId,
          provider: "soniox",
          model: "stt-rt-v6",
          seconds: s.variant === "fail-11" ? seconds / 2 : seconds,
          at: new Date().toISOString(),
        });
        s.logs ??= [];
        s.logs.push({ message: "voice input stopped", data: { sessionId, outcome: "ended" } });
      });
      out({ type: "ended" });
      ws.close();
    }
  });
  ws.on("close", () => timers.forEach((t) => clearTimeout(t)));
}

/** Words with their following space for spaced text, else single characters. */
function split(text) {
  return /\s/.test(text) ? text.match(/\S+\s*/g) : [...text];
}

function garble(text) {
  return split(text)
    .map((piece, i) =>
      i % 4 === 3 ? (/\s/.test(text) ? `wrong${piece.match(/\s*$/)[0]}` : "错") : piece,
    )
    .join("");
}

function page(variant, gate, chat, lang) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Chat</title></head>
<body>
<nav>${CHATS.filter((c) => c !== chat)
    .map((c) => `<a href="/chat/${c}">Chat ${c}</a>`)
    .join(" ")}</nav>
<form id="composer">
  <textarea aria-label="Message" rows="4" cols="60"></textarea>
  <input type="file" aria-label="Attach a picture">
  <ul role="listbox" hidden><li role="option">Notes</li></ul>
  <button type="button" aria-pressed="false"${gate ? "" : " hidden"}>Start voice input</button>
</form>
<script>
const variant = ${JSON.stringify(variant)};
const NOTICES = ${JSON.stringify(NOTICES)};
// Like the dashboard: the guardian's language setting, else the browser's.
const lang = ${JSON.stringify(lang ?? null)} ?? ((navigator.languages[0] ?? navigator.language).startsWith("zh") ? "zh" : "en");
const words = NOTICES[lang];
let chat = ${JSON.stringify(chat)};
const form = document.getElementById("composer");
const field = form.querySelector("textarea");
const button = form.querySelector("button");
const mentions = form.querySelector("[role=listbox]");
const fileInput = form.querySelector("input[type=file]");
let attachments = [];
let listening = null;

// One draft per chat in local storage: the field's text and why listening stopped.
const draftKey = (c) => "draft:" + c;
function saveDraft(reason) {
  if (variant === "fail-7") return;
  const old = JSON.parse(localStorage.getItem(draftKey(chat)) ?? "{}");
  localStorage.setItem(
    draftKey(chat),
    JSON.stringify({ text: field.value, reason: reason === undefined ? old.reason ?? null : reason }),
  );
}
function loadDraft() {
  const draft = JSON.parse(localStorage.getItem(draftKey(chat)) ?? "null");
  field.value = draft?.text ?? "";
  notice(draft?.reason ? words[draft.reason] : null);
}

function notice(text) {
  form.querySelector("[role=status]")?.remove();
  if (!text) return;
  const el = document.createElement("p");
  el.setAttribute("role", "status");
  el.textContent = text;
  form.append(el);
}

fileInput.addEventListener("change", () => {
  attachments = [...fileInput.files].map((f) => ({ type: "image", name: f.name, mimeType: f.type }));
});

function postMessage() {
  return fetch("/api/chats/" + chat + "/messages", {
    method: "POST",
    body: JSON.stringify({ text: field.value, attachments }),
  });
}

async function sendMessage() {
  if (variant === "fail-8" && blocked) return;
  await postMessage();
  field.value = "";
  attachments = [];
  fileInput.value = "";
  localStorage.removeItem(draftKey(chat));
  notice(null);
}

// Like the product's picker: apps first, then Enter on an app lists its agents.
const option = mentions.querySelector("[role=option]");
field.addEventListener("input", () => {
  mentions.hidden = !field.value.slice(0, field.selectionStart).endsWith("@");
  option.textContent = "Notes";
  notice(null);
  saveDraft(null);
});

field.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  if (listening) {
    enterWhileListening();
    return;
  }
  if (!mentions.hidden) {
    if (option.textContent === "Notes") {
      option.textContent = "Notes keeper";
      return;
    }
    mentions.hidden = true;
    document.execCommand("insertText", false, "Notes keeper ");
    return;
  }
  sendMessage();
});

function setListening(on) {
  if (variant === "fail-1") {
    setTimeout(() => showListening(on), 800);
    return;
  }
  showListening(on);
}

function showListening(on) {
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.textContent = on ? words.stop : words.start;
}
setListening(false);

let blocked = false;
navigator.permissions.query({ name: "microphone" }).then((p) => {
  blocked = p.state === "denied";
  if (variant === "fail-8" && blocked) button.hidden = true;
});

async function start() {
  const at = field.selectionStart ?? field.value.length;
  const head = field.value.slice(0, at);
  const lead = head === "" || /[\\s\\u3400-\\u9fff]$/u.test(head) ? "" : " ";
  const tail = field.value.slice(field.selectionEnd ?? at);
  const asked = await navigator.permissions.query({ name: "microphone" });
  if (asked.state === "prompt" && variant !== "fail-8") notice(words.reason);
  let stream;
  try {
    const chosen = localStorage.getItem("voice-mic");
    const audio = chosen && variant !== "fail-12" ? { deviceId: { exact: chosen } } : true;
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch {
    notice(variant === "fail-8" ? null : words.blocked);
    return;
  }
  notice(null);
  const source = new EventSource("/api/voice/listen");
  listening = {
    head,
    tail,
    lead,
    source,
    stream,
    heard: "",
    startedAt: performance.now(),
    hideHearing: showHearing(stream),
  };
  source.addEventListener("done", () => {
    if (listening) listening.done = true;
  });
  setListening(true);
  source.onmessage = (event) => {
    listening.heard = lead + JSON.parse(event.data);
    if (variant === "fail-2") return;
    field.value = variant === "fail-6" ? listening.heard : head + listening.heard + tail;
    saveDraft();
  };
  source.addEventListener("silence", (event) => {
    if (variant === "fail-9") return;
    const ms = JSON.parse(event.data) * 1000;
    listening.silence = setTimeout(() => stop("silence"), ms);
  });
  source.addEventListener("failure", () => stop("error"));
  source.onerror = () => listening && !unloading && stop("lost");
}

/** Stops listening; \`reason\` is why, when it was not the guardian's stop action. */
function stop(reason) {
  const { head, tail, source, stream, heard, startedAt, silence, hideHearing } = listening;
  source.close();
  hideHearing();
  clearTimeout(silence);
  if (variant !== "fail-9") for (const track of stream.getTracks()) track.stop();
  // Rome reports the seconds listened to Rome Cloud when listening stops.
  fetch("/api/voice/usage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seconds: (performance.now() - startedAt) / 1000 }),
  }).catch(() => {});
  listening = null;
  setListening(false);
  if (reason && variant === "fail-7") {
    field.value = head + tail;
    return;
  }
  if (variant === "fail-6") {
    field.value = heard;
  } else {
    // One insertText makes the spoken words a single undo step.
    field.value = head + tail;
    field.focus();
    field.setSelectionRange(head.length, head.length);
    document.execCommand("insertText", false, heard);
  }
  if (reason) {
    saveDraft(reason);
    notice(words[reason]);
  }
  if (variant === "fail-5") postMessage();
}

button.addEventListener("click", () => (listening ? stop() : start()));

// Enter ends listening and sends: the microphone closes at once, and the message goes once the
// transcriber has sent the words still arriving.
function enterWhileListening() {
  if (variant === "fail-13") {
    stop();
    sendMessage();
    return;
  }
  for (const track of listening.stream.getTracks()) track.stop();
  const finish = () => {
    if (!listening) return;
    stop();
    sendMessage();
  };
  if (listening.done) return finish();
  listening.source.addEventListener("done", finish);
  setTimeout(finish, 3000);
}

/**
 * A waveform in the form that scrolls the last second of sound, as the dashboard's does. In
 * silence it draws nothing new, so it holds still once the sound has scrolled out.
 */
function showHearing(stream) {
  const wave = document.createElement("canvas");
  wave.className = "hearing";
  wave.width = 120;
  wave.height = 16;
  form.append(wave);
  if (variant === "fail-14") {
    wave.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 400, iterations: Infinity });
    return () => wave.remove();
  }
  const pen = wave.getContext("2d");
  pen.fillStyle = "#06c";
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let frame;
  const draw = () => {
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
    const height = rms < 0.01 ? 0 : Math.min(16, Math.round(rms * 100));
    pen.globalCompositeOperation = "copy";
    pen.drawImage(wave, -2, 0);
    pen.globalCompositeOperation = "source-over";
    pen.clearRect(118, 0, 2, 16);
    if (height) pen.fillRect(118, 8 - height / 2, 2, height);
    frame = requestAnimationFrame(draw);
  };
  draw();
  return () => {
    cancelAnimationFrame(frame);
    context.close();
    wave.remove();
  };
}

// Opening another chat is in-app: the field shows that chat's draft.
function openChat(next) {
  if (listening) stop("left");
  saveDraft();
  chat = next;
  loadDraft();
}
document.querySelector("nav").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  history.pushState({}, "", link.href);
  openChat(link.pathname.split("/").pop());
});
addEventListener("popstate", () => openChat(location.pathname.match(/^\\/chat\\/([^/]+)$/)?.[1] ?? "c1"));
let unloading = false;
addEventListener("beforeunload", () => {
  unloading = true;
});
addEventListener("pagehide", () => {
  if (listening) {
    const { head, tail, heard } = listening;
    field.value = head + heard + tail;
    saveDraft("reloaded");
  }
});
loadDraft();
</script>
</body></html>`;
}

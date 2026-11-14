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
//   fail-9   the microphone stays open after listening stops, and silence never stops it
import { createServer } from "node:http";
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
];

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
  },
  zh: {
    reason: "Rome 使用麦克风将你的语音转成文字",
    blocked: "麦克风已被阻止。请在浏览器的网站设置中允许",
    left: "离开此聊天时已停止收听",
    reloaded: "页面重新加载时已停止收听",
    lost: "与 Rome 的连接已断开，已停止收听",
    silence: "30 秒未检测到语音，已停止收听",
    error: "语音输入失败，已停止收听",
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
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/chat" || chatPath))
    return send(
      200,
      "text/html; charset=utf-8",
      page(state.variant, voiceOffered(state), chatPath?.[1] ?? CHATS[0]),
    );
  if (req.method === "GET" && url.pathname === "/settings")
    return send(
      200,
      "text/html; charset=utf-8",
      `<main><h1>Settings</h1><p>Voice input: ${PLACE.provider}, ${PLACE.host}</p></main>`,
    );
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
  if (!message) {
    res.end();
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
  const watch = setInterval(() => {
    if (readState(statePath).networkCut) res.destroy();
  }, 100);
  req.on("close", () => {
    clearInterval(watch);
    timers.forEach((t) => t && clearTimeout(t));
  });
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

function page(variant, gate, chat) {
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
const words = NOTICES[(navigator.languages[0] ?? navigator.language).startsWith("zh") ? "zh" : "en"];
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
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.textContent = on ? "Stop voice input" : "Start voice input";
}

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
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    notice(variant === "fail-8" ? null : words.blocked);
    return;
  }
  notice(null);
  const source = new EventSource("/api/voice/listen");
  listening = { head, tail, lead, source, stream, heard: "", startedAt: performance.now() };
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
  const { head, tail, source, stream, heard, startedAt, silence } = listening;
  source.close();
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

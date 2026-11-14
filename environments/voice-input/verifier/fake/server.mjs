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
import { createServer } from "node:http";
import { basename } from "node:path";
import { readState, updateState } from "./state.mjs";

export const VARIANTS = ["good", "fail-2", "fail-3", "fail-5", "fail-6", "fail-10", "fail-11"];

const PLACE = { provider: "Soniox", host: "stt-rt.soniox.com" };

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
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/chat"))
    return send(200, "text/html; charset=utf-8", page(state.variant));
  if (req.method === "GET" && url.pathname === "/settings")
    return send(
      200,
      "text/html; charset=utf-8",
      `<main><h1>Settings</h1><p>Voice input: ${PLACE.provider}, ${PLACE.host}</p></main>`,
    );
  if (req.method === "GET" && url.pathname === "/api/voice-input")
    return send(200, "application/json", JSON.stringify({ place: PLACE }));
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
      s.cloud.usage.push({
        provider: "soniox",
        model: "stt-rt-v6",
        seconds: s.variant === "fail-11" ? seconds / 2 : seconds,
        at: new Date().toISOString(),
      });
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
  const message = script.messages.find((m) => basename(m.path) === basename(state.mic ?? ""));
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  if (!message) {
    res.end();
    return;
  }
  const text = state.transcriber.mode === "real" ? message.text : state.transcriber.text;
  const pieces = split(state.variant === "fail-3" ? garble(text) : text);
  const first = message.firstWordAt + 0.3;
  const last = message.lastWordAt + 0.4;
  const timers = pieces.map((_, i) => {
    const at = pieces.length === 1 ? last : first + ((last - first) * i) / (pieces.length - 1);
    return setTimeout(() => {
      res.write(`data: ${JSON.stringify(pieces.slice(0, i + 1).join(""))}\n\n`);
      if (i === pieces.length - 1) res.end();
    }, at * 1000);
  });
  req.on("close", () => timers.forEach(clearTimeout));
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

function page(variant) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Chat</title></head>
<body>
<form id="composer">
  <textarea aria-label="Message" rows="4" cols="60"></textarea>
  <input type="file" aria-label="Attach a picture">
  <ul role="listbox" hidden><li role="option">Notes</li></ul>
  <button type="button" aria-pressed="false">Start voice input</button>
</form>
<script>
const variant = ${JSON.stringify(variant)};
const chat = "c1";
const form = document.getElementById("composer");
const field = form.querySelector("textarea");
const button = form.querySelector("button");
const mentions = form.querySelector("[role=listbox]");
const fileInput = form.querySelector("input[type=file]");
let attachments = [];
let listening = null;

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
  await postMessage();
  field.value = "";
  attachments = [];
  fileInput.value = "";
}

// Like the product's picker: apps first, then Enter on an app lists its agents.
const option = mentions.querySelector("[role=option]");
field.addEventListener("input", () => {
  mentions.hidden = !field.value.slice(0, field.selectionStart).endsWith("@");
  option.textContent = "Notes";
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

function start() {
  const at = field.selectionStart ?? field.value.length;
  const head = field.value.slice(0, at);
  const lead = head === "" || /[\\s\\u3400-\\u9fff]$/u.test(head) ? "" : " ";
  const tail = field.value.slice(field.selectionEnd ?? at);
  const source = new EventSource("/api/voice/listen");
  listening = { head, tail, source, heard: "", startedAt: performance.now() };
  setListening(true);
  source.onmessage = (event) => {
    listening.heard = lead + JSON.parse(event.data);
    if (variant === "fail-2") return;
    field.value = variant === "fail-6" ? listening.heard : head + listening.heard + tail;
  };
  source.onerror = () => source.close();
}

function stop() {
  const { head, tail, source, heard, startedAt } = listening;
  source.close();
  // Rome reports the seconds listened to Rome Cloud when listening stops.
  fetch("/api/voice/usage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seconds: (performance.now() - startedAt) / 1000 }),
  });
  listening = null;
  setListening(false);
  if (variant === "fail-6") {
    field.value = heard;
  } else {
    // One insertText makes the spoken words a single undo step.
    field.value = head + tail;
    field.focus();
    field.setSelectionRange(head.length, head.length);
    document.execCommand("insertText", false, heard);
  }
  if (variant === "fail-5") postMessage();
}

button.addEventListener("click", () => (listening ? stop() : start()));
</script>
</body></html>`;
}

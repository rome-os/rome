// Records the stand-in instance's answers from the environment's real Rome:
// every route the iOS app calls on launch, in the main Chat and a topic chat,
// for voice input and for a typed send, and the live events the send makes.
// Nobody edits the fixtures by hand; rerun this when the product changes them.
//
//   node record.mjs --dashboard http://127.0.0.1:4780 --user guardian
//     (the guardian's password on stdin; voice-env ios-record runs it)
//
// The route list follows ios/Rome/Networking/RomeBackend.swift. A route the
// app calls that is missing here shows up as "unrecorded" in the stand-in's
// log on CI; add it below and record again.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WebSocket = createRequire(resolve(here, "../../../packages/core/package.json"))("ws");

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const dashboard = args.dashboard;
let password = "";
for await (const chunk of process.stdin) password += chunk;
password = password.trim();

// The stand-in model starts a task when a guardian message holds this.
const TASK_MARKER = "[stand-in: start a task]";
const entries = [];
let cookie = "";

async function call(method, path, { query, body, keep = true } = {}) {
  const q = query ? `?${new URLSearchParams(query)}` : "";
  const res = await fetch(`${dashboard}/api${path}${q}`, {
    method,
    headers: {
      origin: dashboard,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (keep)
    entries.push({
      method,
      path: `/api${path}`,
      query: query ? new URLSearchParams(query).toString() : "",
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
      ...(json === undefined ? { text } : { body: json }),
    });
  return { status: res.status, json, res };
}

// 1. Launch: the local sign-in, then what the workspace loads.
const login = await call("POST", "/auth/login", { body: { userId: args.user, password } });
if (login.status !== 200) throw new Error(`sign-in failed: ${login.status}`);
const setCookie = login.res.headers.getSetCookie();
cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
const cookieNames = setCookie.map((c) => c.split("=")[0]);

for (const path of [
  "/auth/me",
  "/build-info",
  "/system/upgrade/check",
  "/settings",
  "/concierge/session",
  "/concierge/chats",
  "/concierge/connectors",
  "/chat/sessions",
  "/apps",
  "/routines",
  "/ai-tools/status",
  "/voice-input",
])
  await call("GET", path);
await call("GET", "/concierge/tasks", { query: { doneDays: "30" } });
await call("GET", "/approvals", { query: { status: "pending" } });

// 2. The message fields. A chat's id is its session's id. The topic chat is
// started the way the drawer's "New topic chat" does.
const chatSession = (await call("GET", "/concierge/session", { keep: false })).json.id;
const listChats = async (keep) =>
  (await call("GET", "/concierge/chats", { keep })).json.chats ?? [];
let topic = (await listChats(false)).find((c) => !c.main);
if (!topic) {
  topic = (await call("POST", "/concierge/chats", { body: {} })).json;
  await listChats(true);
}

async function openField(sessionId) {
  for (const limit of ["20", "50"])
    await call("GET", `/chat/sessions/${sessionId}/messages`, { query: { limit } });
  await call("GET", `/chat/sessions/${sessionId}/turns`);
  await call("GET", `/chat/sessions/${sessionId}/shares`);
  await call("POST", `/chat/sessions/${sessionId}/read`);
  await call("GET", `/chats/${sessionId}/tasks`);
}
await openField(chatSession);
await openField(topic.id);

// 3. Typed sends in the main Chat, with the live events they make on the
// topics a field subscribes to. The first asks the stand-in model to start a
// task, which gives the main Chat a task card and a thread.
const topicsFor = (id) => [
  "chat.status",
  "concierge.activity",
  "concierge.tasks",
  `chat.session:${id}`,
  `chat.tasks:${id}`,
  `chat.watch:${id}`,
];
const frames = [];
const ws = new WebSocket(`${dashboard.replace(/^http/, "ws")}/ws/events`, {
  headers: { cookie, origin: dashboard },
});
await new Promise((ok, fail) => {
  ws.on("open", ok);
  ws.on("error", fail);
});
ws.on("message", (data) => frames.push({ at: Date.now(), ...JSON.parse(String(data)) }));
const subscribed = topicsFor(chatSession);
for (const t of subscribed) ws.send(JSON.stringify({ type: "subscribe", topic: t }));
await new Promise((r) => setTimeout(r, 1000));

async function until(what, test, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} did not happen`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const idle = (id) =>
  until(`the turn in ${id} to end`, async () => {
    const turns = (await call("GET", `/chat/sessions/${id}/turns`, { keep: false })).json;
    return Array.isArray(turns) && turns.length === 0;
  });
const send = (text) =>
  call("POST", `/chat/sessions/${chatSession}/turns`, {
    body: { text, inputId: randomUUID(), priority: "next" },
    keep: false,
  });

const asked = await send(`${TASK_MARKER} Look into the dentist appointment.`);
if (asked.status >= 300)
  throw new Error(`the task request failed: ${asked.status} ${JSON.stringify(asked.json)}`);
const task = await until("the task", async () =>
  (
    (await call("GET", "/concierge/tasks", { query: { doneDays: "30" }, keep: false })).json
      .tasks ?? []
  ).find((t) => t.chat?.id),
);
await idle(chatSession);
const threadRoot = await until("the thread", async () =>
  (
    (
      await call("GET", `/chat/sessions/${chatSession}/messages`, {
        query: { limit: "50" },
        keep: false,
      })
    ).json.messages ?? []
  ).find((m) => m.chatThreadId),
);

// The fields after the task, as the app loads them on opening each.
await call("GET", "/concierge/tasks", { query: { doneDays: "30" } });
await call("GET", "/concierge/chats");
await call("GET", "/chat/sessions");
await openField(chatSession);
await call("GET", `/chat/sessions/${chatSession}/messages`, {
  query: { thread: threadRoot.chatThreadId },
});
await call("GET", `/chat/sessions/${chatSession}/messages`, { query: { thread: threadRoot.id } });
await openField(task.chat.id);

const before = frames.length;
const sent = "The stand-in instance records this message.";
const turn = await send(sent);
if (turn.status >= 300)
  throw new Error(`the typed send failed: ${turn.status} ${JSON.stringify(turn.json)}`);
await idle(chatSession);
await new Promise((r) => setTimeout(r, 1000));
ws.close();
const sendFrames = frames.slice(before).map(({ at, ...f }) => f);
const after = await call("GET", `/chat/sessions/${chatSession}/messages`, {
  query: { limit: "20" },
  keep: false,
});
const sentMessages = (after.json.messages ?? []).filter(
  (m) =>
    !(threadRoot && m.id === threadRoot.id) &&
    JSON.stringify(m).includes("stand-in instance records"),
);

const out = resolve(here, "fixtures");
mkdirSync(out, { recursive: true });
const fields = {
  chat: chatSession,
  topic: topic.id,
  task: task.chat.id,
  thread: { sessionId: chatSession, root: threadRoot.id, chatThreadId: threadRoot.chatThreadId },
};
writeFileSync(
  resolve(out, "http.json"),
  `${JSON.stringify(
    {
      recordedFrom: "the voice-input environment's Rome",
      product: args.product ?? null,
      cookieNames,
      fields,
      entries,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  resolve(out, "events.json"),
  `${JSON.stringify(
    {
      subscribed,
      send: {
        sessionId: chatSession,
        text: sent,
        turn: turn.json,
        // The messages the send added, as the page after it lists them.
        messages: sentMessages,
        frames: sendFrames,
      },
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    entries: entries.length,
    frames: sendFrames.length,
    sent: sentMessages.length,
    fields,
  }),
);
process.exit(0);

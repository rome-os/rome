// Run: node --test environments/slack-app/tools/port.test.mjs
// ctl.sh port end to end, with a stand-in for the instance that does what
// Rome's agent turn does with the model proxy: it asks the proxy for the turn,
// runs the execute_action call the proxy makes, and sends the result back.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const tools = fileURLToPath(new URL(".", import.meta.url));
const upstreamSeen = [];
let upstream;
let proxy;
let instance;
const children = [];

function freePort() {
  return 20000 + Math.floor(Math.random() * 30000);
}

async function startProxy(env) {
  const port = freePort();
  const control = env.MODEL_PROXY_CONTROL_PORT;
  const child = spawn(process.execPath, [join(tools, "model-proxy.mjs")], {
    env: {
      ...process.env,
      MODEL_PROXY_PORT: String(port),
      MODEL_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      MODEL_PROXY_API_KEY: "real-key",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  // One line per listener.
  await new Promise((resolve) => {
    let lines = 0;
    child.stdout.on("data", (d) => {
      lines += String(d).trim().split("\n").length;
      if (lines >= (control ? 2 : 1)) resolve();
    });
  });
  return { port, control };
}

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    upstreamSeen.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" }).end('{"real":true}');
  }).listen(0);
  await new Promise((r) => upstream.once("listening", r));
  proxy = await startProxy({ MODEL_PROXY_CONTROL_PORT: String(freePort()) });
});

after(() => {
  upstream.close();
  instance?.close();
  for (const c of children) c.kill();
});

const TOOLS = [{ name: "mcp__rome__list_actions" }, { name: "mcp__rome__execute_action" }];

/** One model request as the agent's CLI sends it, answered by the proxy. */
async function modelRequest(body) {
  const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "placeholder" },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 100, ...body }),
  });
  return { status: r.status, text: await r.text() };
}

/** The content blocks of a streamed answer. */
function blocksOf(sse) {
  const blocks = [];
  for (const chunk of sse.split("\n\n")) {
    const data = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!data) continue;
    const e = JSON.parse(data.slice(6));
    if (e.type === "content_block_start") blocks[e.index] = { ...e.content_block };
    if (e.type === "content_block_delta" && e.delta.type === "input_json_delta")
      blocks[e.index].input = JSON.parse(e.delta.partial_json);
    if (e.type === "content_block_delta" && e.delta.type === "text_delta")
      blocks[e.index].text = e.delta.text;
  }
  return blocks;
}

test("the proxy answers a marked turn with one execute_action call and keeps its result", async () => {
  const control = `http://127.0.0.1:${proxy.control}`;
  const job = { action_name: "connector:connector_proxy", json_args: { toolkit: "slack" } };
  const reg = await fetch(`${control}/_port`, {
    method: "POST",
    body: JSON.stringify({ nonce: "abc12345", ...job }),
  });
  assert.equal(reg.status, 201);
  const marked = [{ role: "user", content: "slackenv-port:abc12345" }];
  // A title request has no tools: a short text, no call.
  const title = await modelRequest({ messages: marked });
  assert.equal(JSON.parse(title.text).content[0].type, "text");
  const first = await modelRequest({ stream: true, tools: TOOLS, messages: marked });
  const [call] = blocksOf(first.text);
  assert.equal(call.type, "tool_use");
  assert.equal(call.name, "mcp__rome__execute_action");
  assert.deepEqual(call.input, job);
  // Asked again before a result: never a second call.
  const again = await modelRequest({ stream: true, tools: TOOLS, messages: marked });
  assert.equal(blocksOf(again.text)[0].type, "text");
  const second = await modelRequest({
    stream: true,
    tools: TOOLS,
    messages: [
      ...marked,
      { role: "assistant", content: [call] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            content: [{ type: "text", text: '{"a":1}' }],
          },
        ],
      },
    ],
  });
  assert.equal(blocksOf(second.text)[0].type, "text");
  const done = await fetch(`${control}/_port/abc12345`).then((r) => r.json());
  assert.equal(done.state, "done");
  assert.deepEqual(done.result, { text: '{"a":1}', is_error: false });
  assert.equal(upstreamSeen.length, 0, "nothing marked reached the real model");
});

test("an unknown marker, or a turn with no execute_action, fails loudly and reaches no model", async () => {
  const unknown = await modelRequest({
    tools: TOOLS,
    messages: [{ role: "user", content: "slackenv-port:nosuchjob1" }],
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.text, /no job nosuchjob1/);
  const control = `http://127.0.0.1:${proxy.control}`;
  await fetch(`${control}/_port`, {
    method: "POST",
    body: JSON.stringify({ nonce: "notool123", action_name: "x:y", json_args: {} }),
  });
  const noTool = await modelRequest({
    tools: [{ name: "mcp__rome__list_actions" }],
    messages: [{ role: "user", content: "slackenv-port:notool123" }],
  });
  assert.equal(noTool.status, 400);
  const job = await fetch(`${control}/_port/notool123`).then((r) => r.json());
  assert.equal(job.state, "failed");
  assert.match(job.error, /no execute_action/);
  assert.equal(upstreamSeen.length, 0);
});

test("without a control port, as in the live stack, the proxy forwards everything", async () => {
  const live = await startProxy({});
  const before = upstreamSeen.length;
  const r = await fetch(`http://127.0.0.1:${live.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "slackenv-port:abc12345" }] }),
  });
  assert.equal(await r.text(), '{"real":true}');
  assert.equal(upstreamSeen.length, before + 1);
});

test("ctl.sh port prints the port's answer, and says where a refusal came from", async () => {
  const executions = [];
  const deleted = [];
  // What the stand-in's connector_proxy answers, by the call's arguments.
  const run = (args) => {
    const text = args.json_args.body?.text;
    if (text === "unknown action") return { thrown: "Unknown action: connector:connector_proxy" };
    if (text === "approval") return { output: { pendingApproval: true, message: "submitted" } };
    if (text === "blocked") return { output: { status: "error", error: "blocked by Rome" } };
    executions.push({
      rootExecution: { args: args.json_args, createdAt: new Date().toISOString() },
    });
    if (text === "not in channel")
      return { output: { status: "error", error: "Slack refused: not_in_channel" } };
    return { output: { status: 200, data: { ok: true, ts: "1.000001" }, headers: {}, via: "app" } };
  };
  instance = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const json = (v) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    assert.match(req.headers.cookie, /rome_session=s1/);
    if (req.method === "POST" && req.url === "/api/chat/sessions") return json({ id: "chat-1" });
    if (req.method === "DELETE") {
      deleted.push(req.url);
      return json({ ok: true });
    }
    if (req.url.startsWith("/api/action-executions")) return json(executions);
    if (req.method === "POST" && req.url.endsWith("/turns")) {
      json({ ok: true });
      // The turn, as the agent's CLI runs it against the model proxy.
      const messages = [{ role: "user", content: body.text }];
      const first = await modelRequest({ stream: true, tools: TOOLS, messages });
      const call = blocksOf(first.text)[0];
      if (call?.type !== "tool_use") return;
      const outcome = run(call.input);
      await modelRequest({
        stream: true,
        tools: TOOLS,
        messages: [
          ...messages,
          { role: "assistant", content: [call] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: outcome.thrown ?? JSON.stringify(outcome.output),
                ...(outcome.thrown ? { is_error: true } : {}),
              },
            ],
          },
        ],
      });
      return;
    }
    res.writeHead(404).end();
  }).listen(0);
  await new Promise((r) => instance.once("listening", r));
  const dir = mkdtempSync(join(tmpdir(), "port-"));
  writeFileSync(join(dir, "cookies.json"), JSON.stringify({ rome_session: "s1" }));
  const port = (op, args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [
          join(tools, "port.mjs"),
          op,
          JSON.stringify(args),
          "--instance",
          `http://127.0.0.1:${instance.address().port}`,
          "--cookies",
          join(dir, "cookies.json"),
          "--proxy",
          `http://127.0.0.1:${proxy.control}`,
          "--timeout",
          "10",
        ],
        (err, out) => resolve({ code: err?.code ?? 0, out: JSON.parse(out) }),
      ),
    );

  const sent = await port("send", { chat: "C1", text: "hello", thread: "1.0" });
  assert.equal(sent.code, 0);
  assert.deepEqual(sent.out, {
    status: 200,
    data: { ok: true, ts: "1.000001" },
    headers: {},
    via: "app",
  });
  assert.deepEqual(executions.at(-1).rootExecution.args, {
    toolkit: "slack",
    path: "/api/chat.postMessage",
    method: "POST",
    body: { channel: "C1", text: "hello", thread_ts: "1.0" },
  });
  assert.deepEqual(deleted, ["/api/chat/sessions/chat-1"]);

  assert.deepEqual((await port("send", { chat: "C1", text: "not in channel" })).out, {
    refused: "Slack refused: not_in_channel",
    at: "connector",
  });
  assert.deepEqual((await port("send", { chat: "C1", text: "blocked" })).out, {
    refused: "blocked by Rome",
    at: "rome",
  });
  assert.deepEqual((await port("send", { chat: "C1", text: "unknown action" })).out, {
    refused: "Unknown action: connector:connector_proxy",
    at: "rome",
  });
  assert.deepEqual((await port("send", { chat: "C1", text: "approval" })).out, {
    refused: "submitted",
    at: "rome",
  });

  await port("read", { chat: "C1", limit: 5 });
  assert.deepEqual(executions.at(-1).rootExecution.args.body, { channel: "C1", limit: 5 });
  await port("thread", { chat: "C1", ts: "1.0" });
  assert.equal(executions.at(-1).rootExecution.args.path, "/api/conversations.replies");
  await port("groups", {});
  assert.equal(executions.at(-1).rootExecution.args.path, "/api/conversations.list");
  await port("call", { method: "search.messages", args: { query: "x", channel: "C1" } });
  assert.deepEqual(executions.at(-1).rootExecution.args.body, { query: "x", channel: "C1" });

  const bad = await port("send", { chat: "C1" });
  assert.equal(bad.code, 2);
});

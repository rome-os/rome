// Run: node --test environments/slack-app/tools/model-proxy.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const seen = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
  if (req.url === "/v1/cut-off") {
    // A stream that breaks after its first event.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message_start\ndata: {}\n\n");
    setTimeout(() => res.socket.destroy(), 20);
    return;
  }
  if (seen.at(-1).body.stream) {
    // A message stream: the input side first, the output in the last delta.
    res.writeHead(200, { "content-type": "text/event-stream" });
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      cache_read_input_tokens: 50000,
      output_tokens: 1,
    };
    res.write(
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\n`,
    );
    res.write(
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 400 } })}\n\n`,
    );
    return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end('{"ok":true,"usage":{"input_tokens":1000000,"output_tokens":100000}}');
}).listen(0);
await new Promise((r) => upstream.once("listening", r));

function startProxy(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./model-proxy.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        MODEL_PROXY_PORT: String(port),
        MODEL_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
        ...env,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return new Promise((resolve) => child.stdout.once("data", () => resolve({ child, port })));
}

const children = [];
after(() => {
  upstream.close();
  for (const c of children) c.kill();
});

async function send(port, headers, extra = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-placeholder", ...headers },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [], ...extra }),
  });
  await res.text();
  return seen.at(-1);
}

const getJson = async (url) => (await fetch(url)).json();

test("pins the model to Opus 5.5, keeps the effort, and swaps in an API key", async () => {
  const p = await startProxy({ MODEL_PROXY_API_KEY: "real-key" });
  children.push(p.child);
  const got = await send(
    p.port,
    { "anthropic-beta": "context-1m-2025-08-07,tools-x" },
    { output_config: { effort: "low" } },
  );
  assert.equal(got.body.model, "claude-opus-5-5");
  assert.deepEqual(got.body.output_config, { effort: "low" });
  assert.equal(got.headers["x-api-key"], "real-key");
  assert.equal(got.headers["anthropic-beta"], "tools-x");
  const stats = await getJson(`http://127.0.0.1:${p.port}/_stats`);
  assert.equal(stats.pinned, "claude-opus-5-5");
  assert.deepEqual(stats.asked, { "claude-sonnet-5-5": 1 });
  assert.deepEqual(stats.sent, { "claude-opus-5-5 low": 1 });
});

test("another model can be pinned", async () => {
  const p = await startProxy({ MODEL_PROXY_API_KEY: "k", MODEL_PROXY_MODEL: "claude-haiku-5-5" });
  children.push(p.child);
  assert.equal((await send(p.port, {})).body.model, "claude-haiku-5-5");
});

test("usage: the tokens and cost of the message turns in a span, streamed or not", async () => {
  const p = await startProxy({ MODEL_PROXY_API_KEY: "k" });
  children.push(p.child);
  const start = Date.now();
  await send(p.port, {}, { output_config: { effort: "low" } });
  await send(p.port, {}, { output_config: { effort: "low" }, stream: true });
  // Counting tokens is not a message turn.
  await fetch(`http://127.0.0.1:${p.port}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
  });
  const mid = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  await send(p.port, {});
  const all = await getJson(`http://127.0.0.1:${p.port}/_usage`);
  assert.equal(all.turns, 3);
  const opus = all.models["claude-opus-5-5"];
  assert.deepEqual(opus.by_effort, { low: 2, unset: 1 });
  assert.equal(opus.input_tokens, 2_000_010);
  assert.equal(opus.output_tokens, 200_400);
  assert.equal(opus.cache_creation_input_tokens, 1000);
  assert.equal(opus.cache_creation_1h_input_tokens, 2000);
  assert.equal(opus.cache_read_input_tokens, 50000);
  // 2,000,010 x $4 + 1,000 x $5 + 2,000 x $8 + 50,000 x $0.20 + 200,400 x $20, per million.
  assert.equal(opus.cost_usd, 12.03904);
  assert.equal(all.cost_usd, 12.03904);
  const span = await getJson(
    `http://127.0.0.1:${p.port}/_usage?since=${new Date(start).toISOString()}&until=${mid}`,
  );
  assert.equal(span.turns, 2);
  assert.equal(span.models["claude-opus-5-5"].output_tokens, 100_400);
  const bad = await fetch(`http://127.0.0.1:${p.port}/_usage?since=yesterday`);
  assert.equal(bad.status, 400);
});

test("a subscription token gets the OAuth beta", async () => {
  const p = await startProxy({ MODEL_PROXY_OAUTH_TOKEN: "oauth-token" });
  children.push(p.child);
  const got = await send(p.port, { "anthropic-beta": "tools-x" });
  assert.equal(got.headers.authorization, "Bearer oauth-token");
  assert.equal(got.headers["x-api-key"], undefined);
  assert.equal(got.headers["anthropic-beta"], "tools-x,oauth-2025-04-20");
  const bare = await send(p.port, {});
  assert.equal(bare.headers["anthropic-beta"], "oauth-2025-04-20");
});

test("a stream cut off upstream ends that response and leaves the proxy running", async () => {
  const p = await startProxy({ MODEL_PROXY_API_KEY: "real-key" });
  children.push(p.child);
  let exited = false;
  p.child.once("exit", () => {
    exited = true;
  });
  const cut = await fetch(`http://127.0.0.1:${p.port}/v1/cut-off`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
  });
  assert.equal(cut.status, 200);
  await assert.rejects(cut.text());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(exited, false);
  const next = await send(p.port, {});
  assert.equal(next.body.model, "claude-opus-5-5");
});

test("an upload cut off by the instance leaves the proxy running", async () => {
  const p = await startProxy({ MODEL_PROXY_API_KEY: "real-key" });
  children.push(p.child);
  let exited = false;
  p.child.once("exit", () => {
    exited = true;
  });
  const { connect } = await import("node:net");
  const socket = connect(p.port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  socket.write(
    'POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":',
  );
  await new Promise((r) => setTimeout(r, 50));
  socket.destroy();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(exited, false);
  const next = await send(p.port, {});
  assert.equal(next.body.model, "claude-opus-5-5");
});

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
  res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
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

async function send(port, headers) {
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-placeholder", ...headers },
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
  });
  return seen.at(-1);
}

test("pins the model and swaps in an API key", async () => {
  const p = await startProxy({ MODEL_PROXY_API_KEY: "real-key" });
  children.push(p.child);
  const got = await send(p.port, { "anthropic-beta": "context-1m-2025-08-07,tools-x" });
  assert.equal(got.body.model, "claude-haiku-5-5");
  assert.equal(got.headers["x-api-key"], "real-key");
  assert.equal(got.headers["anthropic-beta"], "tools-x");
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

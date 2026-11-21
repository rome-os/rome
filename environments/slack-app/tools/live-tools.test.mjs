// Run: node --test environments/slack-app/tools/live-tools.test.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { challenge, signSlack } from "./slack-challenge.mjs";
import { parseRoutes, startTlsProxy } from "./tls-proxy.mjs";

const SECRET = "live-signing-secret";
let cloud;
let cloudPort;
const seen = [];

before(async () => {
  // A stand-in for Rome Cloud's events route: it checks Slack's signature as
  // the product does and answers the challenge.
  cloud = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ host: req.headers.host, proto: req.headers["x-forwarded-proto"] });
      const ts = req.headers["x-slack-request-timestamp"];
      const want = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
      if (req.url === "/access") {
        res.writeHead(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" });
        return res.end();
      }
      if (req.headers["x-slack-signature"] !== want) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"invalid_signature"}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: JSON.parse(body).challenge }));
    });
  }).listen(0);
  await new Promise((r) => cloud.once("listening", r));
  cloudPort = cloud.address().port;
});
after(() => cloud.close());

test("signSlack makes Slack's v0 signature", () => {
  const headers = signSlack("s", "body", 1700000000);
  assert.equal(headers["x-slack-request-timestamp"], "1700000000");
  assert.equal(
    headers["x-slack-signature"],
    `v0=${createHmac("sha256", "s").update("v0:1700000000:body").digest("hex")}`,
  );
});

test("the challenge passes with the right secret and names why it fails otherwise", async () => {
  const url = `http://127.0.0.1:${cloudPort}/api/slack/events`;
  const good = await challenge(url, { secret: SECRET, host: "pantheon.slack.rome.localhost" });
  assert.deepEqual(good, { ok: true, status: 200, url });
  assert.equal(seen.at(-1).host, "pantheon.slack.rome.localhost");
  const wrong = await challenge(url, { secret: "other" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /SLACK_APP_SIGNING_SECRET differs/);
  const access = await challenge(`http://127.0.0.1:${cloudPort}/access`, { secret: SECRET });
  assert.match(access.why, /Bypass/);
  // The command line reads the secret from the environment only.
  const tool = fileURLToPath(new URL("slack-challenge.mjs", import.meta.url));
  // Run apart: a synchronous child would block the stand-in in this process.
  const out = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [tool, url],
      { env: { ...process.env, SLACK_APP_SIGNING_SECRET: SECRET } },
      (e, stdout) => (e ? reject(e) : resolve(stdout)),
    ),
  );
  assert.equal(JSON.parse(out).ok, true);
  assert.ok(!out.includes(SECRET));
});

test("the TLS proxy answers a public name in the network and passes it on by Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tls-proxy-"));
  execFileSync(process.execPath, [
    fileURLToPath(new URL("make-cert.mjs", import.meta.url)),
    dir,
    "slack-pantheon.romeos.dev",
    "slack.romeos.dev",
  ]);
  const cert = readFileSync(join(dir, "tls.crt"));
  const proxy = startTlsProxy({
    cert,
    key: readFileSync(join(dir, "tls.key")),
    port: 0,
    routes: parseRoutes([`slack-pantheon.romeos.dev=127.0.0.1:${cloudPort}`]),
  });
  await new Promise((r) => proxy.once("listening", r));
  const port = proxy.address().port;
  try {
    const fetchVia = (servername) =>
      new Promise((resolve, reject) => {
        get(
          {
            host: "127.0.0.1",
            port,
            servername,
            ca: cert,
            path: "/api/health",
            headers: { host: servername },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        ).on("error", reject);
      });
    // The stand-in answers 401 to an unsigned request: it was reached.
    assert.equal(await fetchVia("slack-pantheon.romeos.dev"), 401);
    assert.deepEqual(seen.at(-1), { host: "slack-pantheon.romeos.dev", proto: "https" });
    assert.equal(await fetchVia("slack.romeos.dev"), 404);
  } finally {
    proxy.close();
  }
});

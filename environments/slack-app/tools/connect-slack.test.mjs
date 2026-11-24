// Runs connect-slack.mjs against the fake Slack, with a stand-in instance and
// a stand-in Rome Cloud callback.
// Run: node --test environments/slack-app/tools/connect-slack.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, start } from "../fake-slack/server.mjs";
import { connect } from "./connect-slack.mjs";

const CLIENT_ID = "111.222";
let fake;
let slack;
let cloud;
let cloudServer;
let instance;
let instanceServer;
const seen = { setups: 0, callbacks: [], refusedCalls: 0 };
let connected = false;

const listen = (server) =>
  new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  fake = start(
    loadConfig({
      port: 0,
      workspacesFile: fileURLToPath(new URL("../config/workspaces.json", import.meta.url)),
      signingSecret: "s",
      clientSecret: "c",
      clientId: CLIENT_ID,
      eventsUrl: "http://127.0.0.1:9/events",
    }),
  );
  await new Promise((r) => fake.servers[0].once("listening", r));
  slack = `http://127.0.0.1:${fake.servers[0].address().port}`;

  // Rome Cloud: its dev sign-in sets a session; its Slack callback needs it.
  cloudServer = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/auth/dev/start") {
      res.writeHead(302, { location: "/", "set-cookie": "session=guardian; Path=/" }).end();
    } else if (url.pathname === "/api/slack/callback") {
      const ok = req.headers.cookie?.includes("session=guardian") && url.searchParams.get("code");
      seen.callbacks.push({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), ok: Boolean(ok) });
      if (ok) connected = true;
      res.writeHead(ok ? 200 : 401).end(ok ? "<p>Connected. You can close this tab.</p>" : "no session");
    } else res.writeHead(200).end("home");
  });
  cloud = await listen(cloudServer);

  // The instance: one setup whose sign-in goes to https://slack.com.
  instanceServer = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (!req.headers.cookie?.includes("rome=1") || (req.method !== "GET" && req.headers.origin !== instance)) {
      seen.refusedCalls++;
      return send(403, { error: "forbidden" });
    }
    if (url.pathname === "/api/connections")
      return send(200, { connections: connected ? [{ id: "conn-1", connectionKind: "slack_app", state: "working" }] : [{ id: null, connectionKind: "slack_app" }] });
    if (url.pathname === "/api/connections/slack_app/grants/bot/setup" && req.method === "POST") {
      seen.setups++;
      const q = new URLSearchParams({ client_id: CLIENT_ID, scope: "app_mentions:read,chat:write", redirect_uri: `${cloud}/api/slack/callback`, state: "st-1" });
      return send(200, { cid: "cid-1", state: { status: "awaiting-redirect", url: `https://slack.com/oauth/v2/authorize?${q}` } });
    }
    if (url.pathname === "/api/setups/cid-1")
      return send(200, { state: connected ? { status: "done", grant: { connectionId: "conn-1" } } : { status: "awaiting-redirect" } });
    send(404, {});
  });
  instance = await listen(instanceServer);
});

after(() => {
  for (const s of fake.servers) s.close();
  cloudServer.close();
  instanceServer.close();
});

test("connects through the approve screen as the guardian, then leaves a connected instance as it is", async () => {
  await fetch(`${slack}/_control/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team: "TA0000AAAA", user: "UA0000GUARD" }),
  });
  const args = {
    instanceUrl: instance,
    cookies: { rome: "1" },
    slack,
    cloudSignIn: `${cloud}/api/auth/dev/start?email=`,
    email: "guardian-a@slackenv.test",
    timeoutMs: 10_000,
  };
  const first = await connect(args);
  assert.equal(first.outcome, "connected", JSON.stringify(first));
  assert.equal(first.connection_id, "conn-1");
  assert.deepEqual(first.path, [
    "https://slack.com/oauth/v2/authorize",
    "https://slack.com/oauth/v2/authorize/approve",
    `${cloud}/api/slack/callback`,
  ]);
  assert.deepEqual(seen.callbacks.map((c) => [c.ok, c.state]), [[true, "st-1"]]);
  const { approvals } = await (await fetch(`${slack}/_control/approvals`)).json();
  assert.deepEqual(approvals.map((a) => [a.teamId, a.userId, a.outcome]), [["TA0000AAAA", "UA0000GUARD", "approved"]]);

  const again = await connect(args);
  assert.equal(again.outcome, "already");
  assert.equal(again.connection_id, "conn-1");
  assert.equal(seen.setups, 1);
  assert.equal(seen.refusedCalls, 0);
});

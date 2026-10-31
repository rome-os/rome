// Launcher for the browser end-to-end suite (packages/web/browser-e2e). It
// boots the real Rome daemon, the same `src/index.ts` that ships, in this
// process, after putting fakes at the two edges a test cannot reach:
//
//   - the model: a loopback Anthropic Messages API (fake-anthropic.ts). The
//     suite stores it as the guardian's custom Anthropic environment, so the
//     real Claude CLI runs every turn against it.
//   - WeChat: a loopback iLink bot API (fake-ilink.ts). Rome's iLink adapter
//     calls the global fetch, so this process routes the iLink origin there.
//   - Telegram: a loopback Bot API for two bots (fake-telegram.ts), reached
//     through grammy's own HTTP client.
//
// Everything else (database, migrations, sessions, chats, channels, the
// built dashboard served by Rome) is production code over a throwaway home
// directory. A small control server lets the tests drive the fakes:
//
//   GET  /health            200 once Rome is listening
//   GET  /model             the model's base URL and every call it answered
//   POST /wechat/emit       { text, from? } → a WeChat message to Rome's bot,
//                           from the guardian unless `from` names another user
//   GET  /wechat/messages   every iLink message, both ways
//   POST /telegram/emit     a person writes in a Telegram chat that one or
//                           more of the fake bots are in (fake-telegram.ts)
//   GET  /telegram/messages every Telegram message each bot saw or sent
//   GET  /unhandled         requests the fakes did not model
//
//   POST /sql               { sql } → rows of a read-only query on Rome's database
//   POST /fixture/save      { dir, manifest } → saves this home as a fixture
//                           (fixture-home.ts)
//
// Environment: E2E_ROME_PORT (default 4610), E2E_CONTROL_PORT (4611),
// E2E_MODEL_PORT (4613), E2E_HOME (a fresh temp dir by default), E2E_WEB_ROOT
// (packages/web/dist), E2E_FIXTURE (a fixture to boot on, copied into the
// home first), E2E_TELEGRAM_FIRST_ID (the first message id the fake Telegram
// gives, so a fixture's ids are not reused).

import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAnthropic } from "./fake-anthropic.js";
import { FakeIlink } from "./fake-ilink.js";
import { FakeTelegram } from "./fake-telegram.js";
import { queryHome, restoreFixture, saveFixture } from "./fixture-home.js";

const here = dirname(fileURLToPath(import.meta.url));
const romePort = Number(process.env.E2E_ROME_PORT ?? 4610);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 4611);
const home = process.env.E2E_HOME ?? mkdtempSync(join(tmpdir(), "rome-browser-e2e-"));
const webRoot = process.env.E2E_WEB_ROOT ?? resolve(here, "../../../../web/dist");
mkdirSync(home, { recursive: true });
if (process.env.E2E_FIXTURE) restoreFixture(process.env.E2E_FIXTURE, home);

const model = new FakeAnthropic();
const ilink = new FakeIlink();
// A fixed port, because Rome stores the model's address with the guardian's
// environment, and a home reused across boots (a fixture) still names it.
await model.start(Number(process.env.E2E_MODEL_PORT ?? romePort + 3));
await ilink.start();
globalThis.fetch = ilink.route(globalThis.fetch);
const telegram = new FakeTelegram(Number(process.env.E2E_TELEGRAM_FIRST_ID ?? 1));
await telegram.start();
telegram.installForGrammy();

// Rome reads its configuration from the environment when it boots.
Object.assign(process.env, {
  HOME: home,
  ROME_PROFILE: "e2e",
  ROME_PROJECTS_ROOT: join(home, "projects"),
  ROME_JWT_SECRET: "browser-e2e-jwt-secret-not-a-real-one",
  INTERNAL_API_PORT: String(romePort),
  INTERNAL_API_WEB_ROOT: webRoot,
  // The legacy web port must not collide with a developer's running Rome.
  WEB_PORT: String(romePort + 2),
});
// A developer shell can carry credentials, a model base URL, telemetry or a
// Rome Cloud origin of its own; a test run uses none of them.
for (const key of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "PANTHEON_BASE_ORIGIN",
  "PANTHEON_DOMAIN",
  "STATSIG_SERVER_SECRET_KEY",
])
  delete process.env[key];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

let romeReady = false;
const control = createServer((req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  void (async () => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/health")
      return json(romeReady ? 200 : 503, { ready: romeReady, home });
    if (req.method === "GET" && path === "/model")
      return json(200, { baseUrl: model.url, calls: model.calls });
    if (req.method === "POST" && path === "/wechat/emit") {
      const body = await readBody(req);
      const from = typeof body.from === "string" ? body.from : undefined;
      return json(200, ilink.emitMessage(String(body.text ?? ""), from));
    }
    if (req.method === "GET" && path === "/wechat/messages") return json(200, ilink.messages);
    if (req.method === "POST" && path === "/telegram/emit")
      return json(200, telegram.emit((await readBody(req)) as Parameters<FakeTelegram["emit"]>[0]));
    if (req.method === "GET" && path === "/telegram/messages") return json(200, telegram.messages);
    if (req.method === "POST" && path === "/sql") {
      const { sql } = await readBody(req);
      return json(200, queryHome(home, String(sql)));
    }
    if (req.method === "POST" && path === "/fixture/save") {
      const { dir, manifest } = await readBody(req);
      saveFixture(home, String(dir), manifest);
      return json(200, { saved: dir });
    }
    if (req.method === "GET" && path === "/unhandled")
      return json(200, {
        model: model.unhandled,
        wechat: ilink.unhandled,
        telegram: telegram.unhandled,
      });
    json(404, { error: path });
  })().catch((error: unknown) => json(500, { error: String(error) }));
});
await new Promise<void>((done) => control.listen(controlPort, "127.0.0.1", done));

// Boots Rome. `main()` runs on import and keeps the process alive.
await import("../../index.js");

// `main()` resolves its listen before it logs "Rome started", but import()
// returns as soon as the module body ran, so poll the port instead.
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${romePort}/api/bootstrap`);
    if (res.ok) break;
  } catch {
    // not listening yet
  }
  await new Promise((done) => setTimeout(done, 500));
}
romeReady = true;
console.log(
  `browser-e2e: Rome on http://127.0.0.1:${romePort}, control on ${controlPort}, home ${home}`,
);

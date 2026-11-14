// The provider try page: one recording from the browser, fanned out to every
// provider that has a credential, with each provider's text streamed back.
// Credentials stay in this process, read from a mode-600 env file. Audio is
// relayed in memory and never written anywhere.
//
//   node environments/voice-input/try/server.mjs [--port 4790]
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PROVIDERS, openSession } from "./providers.mjs";

const require = createRequire(
  fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url)),
);
const { WebSocketServer } = require("ws");

const portArg = process.argv.indexOf("--port");
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : 4790);
const ENV_FILE = process.env.VOICE_ENV_FILE ?? `${homedir()}/.config/rome/voice.env`;
const PAGE = new URL("./index.html", import.meta.url);

// Read on every use, so a key added to the file works without a restart.
function credentials() {
  let text;
  try {
    const mode = statSync(ENV_FILE).mode & 0o077;
    if (mode) console.warn(`${ENV_FILE} is readable by others; chmod 600 it`);
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function providerList() {
  const keys = credentials();
  return PROVIDERS.map(({ id, name, model, pricePerHour, priceSource, priceNote, key }) => ({
    id,
    name,
    model,
    pricePerHour,
    priceSource,
    priceNote,
    configured: Boolean(keys[key]),
  }));
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.endsWith("/providers")) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ providers: providerList(), envFile: ENV_FILE }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(PAGE));
});

const wss = new WebSocketServer({ server, path: undefined });
wss.on("connection", (browser) => {
  const send = (m) => browser.readyState === 1 && browser.send(JSON.stringify(m));
  let sessions = [];
  browser.on("message", async (data, isBinary) => {
    if (isBinary) {
      for (const s of sessions) s.send(Buffer.from(data));
      return;
    }
    const m = JSON.parse(data.toString());
    if (m.type === "start") {
      const keys = credentials();
      sessions = PROVIDERS.filter((p) => keys[p.key]).map((p) =>
        openSession(p, keys[p.key], {
          text: (final, partial) => send({ provider: p.id, type: "text", final, partial }),
          error: (message) => send({ provider: p.id, type: "error", message }),
          closed: () => send({ provider: p.id, type: "closed" }),
        }),
      );
      send({ type: "started" });
    } else if (m.type === "stop") {
      const stopping = sessions;
      sessions = [];
      await Promise.all(stopping.map((s) => s.stop()));
      send({ type: "stopped" });
    }
  });
  browser.on("close", () => {
    for (const s of sessions) s.stop();
    sessions = [];
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`voice try page on http://127.0.0.1:${PORT}, keys from ${ENV_FILE}`),
);

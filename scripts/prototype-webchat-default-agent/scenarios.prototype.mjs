#!/usr/bin/env node
// PROTOTYPE (webchat-default-agent): drive the real local instance and print one
// timestamped trace line per boundary call. Usage:
//   node scripts/prototype-webchat-default-agent/scenarios.prototype.mjs <cmd> [arg]
// Commands: state | set <agent|main> | install [version] | reinstall-watch [version]
//   | disable | enable | uninstall | session [agent] | turn <sessionId> <text>
//   | session-info <sessionId>
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.WDA_BASE ?? "http://127.0.0.1:4310";
const APP_ID = "wda-proto-app";
const AGENT = `${APP_ID}:helper`;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixture-app");

const ts = () => new Date().toISOString();
const trace = (event, data) => console.log(`${ts()} ${event} ${JSON.stringify(data)}`);

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 200);
  }
  return { status: res.status, json };
}

async function snapshot() {
  const [d, agents, app] = await Promise.all([
    call("GET", "/api/chat/default-agent"),
    call("GET", "/api/chat/agents"),
    call("GET", `/api/apps/${APP_ID}`),
  ]);
  const listed = (agents.json ?? []).some?.((g) => g.agents.some((a) => a.name === AGENT));
  return {
    saved: d.json.saved?.agentName ?? null,
    savedLoaded: d.json.savedLoaded,
    effective: d.json.effective,
    catalogListsAgent: Boolean(listed),
    appStatus: app.status,
    appState: app.json?.state ?? app.json?.phase ?? null,
    appEnabled: app.json?.spec?.enabled ?? app.json?.enabled ?? null,
  };
}

/** Copy the fixture with a bumped version so a reinstall is a real upgrade. */
function fixtureSource(version) {
  if (!version) return FIXTURE;
  const dir = mkdtempSync(join(tmpdir(), "wda-fixture-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const manifest = join(dir, "app.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(/^version: .*$/m, `version: ${version}`),
  );
  return dir;
}

const [cmd, arg, arg2] = process.argv.slice(2);
switch (cmd) {
  case "state":
    trace("state", await snapshot());
    break;
  case "set": {
    const r = await call("PUT", "/api/chat/default-agent", {
      agentName: arg === "main" ? null : (arg ?? AGENT),
    });
    trace("PUT /api/chat/default-agent", { status: r.status, body: r.json });
    trace("state", await snapshot());
    break;
  }
  case "install": {
    const r = await call("POST", "/api/apps", {
      source: { mode: "source", path: fixtureSource(arg) },
    });
    trace("POST /api/apps", { status: r.status, phase: r.json.phase, error: r.json.error });
    trace("state", await snapshot());
    break;
  }
  case "reinstall-watch": {
    // Poll while a reinstall/upgrade runs, to catch the window where the
    // catalog does not list the agent, and show the saved default survives it.
    trace("state:before", await snapshot());
    let done = false;
    const seen = new Map();
    const poller = (async () => {
      while (!done) {
        const s = await snapshot();
        const key = JSON.stringify(s);
        if (!seen.has(key)) {
          seen.set(key, true);
          trace("state:during", s);
        }
      }
    })();
    const r = await call("POST", "/api/apps", {
      source: { mode: "source", path: fixtureSource(arg) },
    });
    done = true;
    await poller;
    trace("POST /api/apps", { status: r.status, phase: r.json.phase, error: r.json.error });
    trace("state:after", await snapshot());
    break;
  }
  case "disable":
  case "enable": {
    const r = await call("PATCH", `/api/apps/${APP_ID}`, { enabled: cmd === "enable" });
    trace(`PATCH /api/apps/${APP_ID}`, { status: r.status, body: r.json });
    trace("state", await snapshot());
    break;
  }
  case "uninstall": {
    const r = await call("DELETE", `/api/apps/${APP_ID}`);
    trace(`DELETE /api/apps/${APP_ID}`, { status: r.status, body: r.json });
    trace("state", await snapshot());
    break;
  }
  case "session": {
    // An app/automation caller: agent named explicitly, or omitted entirely.
    const body = { name: "proto", projectPath: "default" };
    if (arg) body.agentName = arg;
    const r = await call("POST", "/api/chat/sessions", body);
    trace("POST /api/chat/sessions", {
      sent: body,
      status: r.status,
      id: r.json.id,
      agentName: r.json.agentName ?? null,
      error: r.json.error,
    });
    break;
  }
  case "turn": {
    const r = await call("POST", `/api/chat/sessions/${arg}/turns`, {
      text: arg2 ?? "hi",
      inputId: crypto.randomUUID(),
    });
    trace(`POST /api/chat/sessions/${arg}/turns`, { status: r.status, body: r.json });
    break;
  }
  case "session-info": {
    const r = await call("GET", `/api/chat/sessions/${arg}`);
    const m = await call("GET", `/api/chat/sessions/${arg}/messages`);
    const msgs = Array.isArray(m.json) ? m.json : (m.json?.messages ?? []);
    trace("GET session", { status: r.status, agentName: r.json.agentName ?? null });
    for (const msg of msgs) {
      const blocks = msg.blocks ?? msg.trace ?? [];
      const agents = [...new Set(blocks.map((b) => b.agent).filter(Boolean))];
      const text = (msg.content ?? blocks.find((b) => b.type === "text")?.content ?? "")
        .toString()
        .slice(0, 80);
      trace("message", { role: msg.role, agents, text });
    }
    break;
  }
  default:
    console.error("unknown command", cmd);
    process.exit(2);
}

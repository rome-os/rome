import { ws } from "msw";
import type { NodeActionRow, NodeEvent, NodeStatus } from "@rome-os/node-ui";

// The rome-node console socket. It answers node.status, log.query, and a `node` subscription
// from the fixtures below, and sends no live events after the snapshot. Device ids match the
// `/api/devices` fixture in settings.ts.
const nodeConsole = ws.link(/\/ws\/node$/);

const minute = 60_000;
const startedAt = Date.now() - 3 * 60 * minute;

const status: NodeStatus = {
  version: "0.1.3",
  startedAt,
  roles: {
    caller: {
      auth: "authorized",
      connection: "online",
      since: Date.now() - 42 * minute,
      reconnects: 1,
      running: 1,
    },
  },
};

function row(id: number, ago: number, fields: Partial<NodeActionRow>): NodeActionRow {
  const start = Date.now() - ago;
  return {
    id,
    direction: "out",
    peer: "linux",
    action: "exec",
    mode: "json",
    command: null,
    args: null,
    cwd: null,
    startedAt: start,
    endedAt: start + 1200,
    outcome: "ok",
    errorCode: null,
    exitCode: 0,
    signal: null,
    stdinBytes: 0,
    stdoutBytes: 2048,
    stderrBytes: 0,
    transfer: null,
    ...fields,
  };
}

const running = row(8, 20_000, {
  command: "bash",
  args: ["-lc", "cd ~/rome && pnpm test:unit"],
  endedAt: null,
  outcome: null,
  exitCode: null,
  stdoutBytes: 0,
});

const history: NodeActionRow[] = [
  row(7, 2 * minute, {
    command: "git",
    args: ["status", "--short"],
    cwd: "/home/dev/rome",
    stdoutBytes: 312,
  }),
  row(6, 5 * minute, {
    command: "bash",
    args: [
      "-lc",
      "set -e\ncd ~/rome\npnpm install --frozen-lockfile\npnpm typecheck\npnpm test:unit -- --reporter=dot",
    ],
    endedAt: Date.now() - 5 * minute + 95_000,
    exitCode: 1,
    stdoutBytes: 48_213,
    stderrBytes: 1_904,
  }),
  row(5, 11 * minute, {
    peer: "mac",
    command: "ls",
    args: ["-la", "/Users/dev/Downloads"],
    stdoutBytes: 5_120,
  }),
  row(4, 25 * minute, {
    peer: "mac",
    action: "copy",
    mode: "copy",
    exitCode: null,
    stdoutBytes: 0,
    transfer: {
      direction: "pull",
      localPath: "/rome-home/.rome/default/projects/demo/report.pdf",
      remotePath: "/Users/dev/Desktop/report.pdf",
      bytes: 3_145_728,
      sha256: "9f2c4a7d0e6b5a3c1f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928",
    },
  }),
  row(3, 47 * minute, {
    peer: "windows",
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-Command",
      "Get-ChildItem C:\\Users\\dev\\Documents | Select-Object Name",
    ],
    endedAt: Date.now() - 47 * minute + 60_000,
    outcome: "unknown_outcome",
    errorCode: "unknown_outcome",
    exitCode: null,
    stdoutBytes: 0,
  }),
  row(2, 70 * minute, {
    peer: "windows",
    command: "cmd.exe",
    args: ["/c", "dir"],
    outcome: "error",
    errorCode: "target_unavailable",
    exitCode: null,
    stdoutBytes: 0,
  }),
  row(1, 2 * 60 * minute, {
    command: "sleep",
    args: ["600"],
    endedAt: startedAt,
    outcome: "interrupted",
    exitCode: null,
    stdoutBytes: 0,
  }),
];

function answer(method: unknown, params: Record<string, unknown>): unknown {
  if (method === "node.status") return status;
  if (method === "events.subscribe" || method === "events.unsubscribe")
    return { subscribed: method === "events.subscribe" };
  if (method === "log.query" && params.kind === "actions") {
    const text = typeof params.text === "string" ? params.text.toLowerCase() : null;
    const rows = [running, ...history].filter(
      (item) =>
        (typeof params.before !== "number" || item.id < params.before) &&
        (!params.peer || item.peer === params.peer) &&
        (!Array.isArray(params.outcome) || params.outcome.includes(item.outcome)) &&
        (!text ||
          [item.command, JSON.stringify(item.args), item.cwd]
            .join(" ")
            .toLowerCase()
            .includes(text)),
    );
    return { rows, hasMore: false };
  }
  return undefined;
}

export const nodeConsoleHandlers = [
  nodeConsole.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const params = message.params ?? {};
      if (message.method === "events.subscribe" && params.topic === "node") {
        const snapshot: NodeEvent = { type: "snapshot", status, running: [running] };
        client.send(JSON.stringify({ jsonrpc: "2.0", method: "events.node", params: snapshot }));
      }
      const result = answer(message.method, params);
      client.send(
        JSON.stringify(
          result === undefined
            ? {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              }
            : { jsonrpc: "2.0", id: message.id, result },
        ),
      );
    });
  }),
];

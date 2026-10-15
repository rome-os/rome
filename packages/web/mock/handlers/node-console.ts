import { ws } from "msw";
import type { NodeActionRow, NodeEvent, NodeStatus } from "@rome-os/node-ui";

// The rome-node console socket. It answers node.status, log.query, log.stats, and a `node`
// subscription from a generated day of activity, then sends a live action every few seconds.
// Device ids match the `/api/devices` fixture in settings.ts.
const nodeConsole = ws.link(/\/ws\/node$/);

const minute = 60_000;
const hour = 60 * minute;
const now = Date.now();
const startedAt = now - 3 * hour;

const status: NodeStatus = {
  version: "0.1.3",
  startedAt,
  roles: {
    caller: {
      auth: "authorized",
      connection: "online",
      since: now - 42 * minute,
      reconnects: 1,
      running: 1,
    },
  },
};

/** A deterministic generator, so every reload shows the same day. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Template = { command: string; args: string[]; cwd: string | null; ms: [number, number] };

const linux: Template[] = [
  { command: "git", args: ["status", "--short"], cwd: "/home/dev/rome", ms: [40, 180] },
  { command: "bash", args: ["-lc", "cd ~/rome && pnpm test:unit"], cwd: null, ms: [6000, 40_000] },
  {
    command: "rg",
    args: ["-n", "DeviceList", "packages/web/src"],
    cwd: "/home/dev/rome",
    ms: [30, 400],
  },
  {
    command: "docker",
    args: ["ps", "--format", "{{.Names}}\t{{.Status}}"],
    cwd: null,
    ms: [60, 260],
  },
  {
    command: "bash",
    args: ["-lc", "set -e\ncd ~/rome\npnpm install --frozen-lockfile\npnpm typecheck"],
    cwd: null,
    ms: [8000, 60_000],
  },
  { command: "cat", args: ["/proc/loadavg"], cwd: null, ms: [4, 12] },
  { command: "df", args: ["-hT", "-x", "tmpfs", "-x", "overlay"], cwd: null, ms: [90, 260] },
];

const mac: Template[] = [
  {
    command: "zsh",
    args: ["-lc", "git -C ~/code/rome log --oneline -10"],
    cwd: null,
    ms: [20, 120],
  },
  {
    command: "open",
    args: ["-a", "Google Chrome", "http://localhost:3000"],
    cwd: null,
    ms: [120, 600],
  },
  { command: "ls", args: ["-la", "/Users/dev/Downloads"], cwd: null, ms: [10, 60] },
  { command: "screencapture", args: ["-x", "/tmp/rome-shot.png"], cwd: null, ms: [300, 900] },
  {
    command: "zsh",
    args: ["-lc", "pnpm --filter @rome-os/ui build"],
    cwd: "/Users/dev/code/rome",
    ms: [3000, 30_000],
  },
];

/** Relative activity by hour of day, so the chart has a shape. */
const profiles: Record<string, (hourOfDay: number) => number> = {
  linux: (h) => 0.5 + Math.exp(-((h - 11) ** 2) / 10) + 1.2 * Math.exp(-((h - 21.5) ** 2) / 6),
  mac: (h) => (h > 1.5 && h < 8.5 ? 0.03 : 0.5 + 1.2 * Math.exp(-((h - 15) ** 2) / 14)),
};

const rows: NodeActionRow[] = [];
let nextId = 1;

function action(
  peer: string,
  start: number,
  template: Template,
  fields: Partial<NodeActionRow> = {},
): NodeActionRow {
  return {
    id: nextId++,
    direction: "out",
    peer,
    action: "exec",
    mode: "json",
    command: template.command,
    args: template.args,
    cwd: template.cwd,
    startedAt: start,
    endedAt: start + template.ms[0],
    outcome: "ok",
    errorCode: null,
    exitCode: 0,
    signal: null,
    stdinBytes: 0,
    stdoutBytes: 512,
    stderrBytes: 0,
    transfer: null,
    ...fields,
  };
}

function generate(peer: string, templates: Template[], total: number, seed: number) {
  const next = random(seed);
  const bucketMs = 10 * minute;
  const first = now - 24 * hour;
  const weights = Array.from({ length: 144 }, (_, index) => {
    const time = first + index * bucketMs;
    const hourOfDay = new Date(time).getHours() + new Date(time).getMinutes() / 60;
    const burst = next() < 0.06 ? 2 + next() * 2 : 1;
    return profiles[peer]!(hourOfDay) * burst * (0.75 + next() * 0.5);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const made: NodeActionRow[] = [];
  weights.forEach((weight, index) => {
    const count = Math.round((total * weight) / sum);
    // A short failure storm on the busiest machine, about 06:00 to 06:50 ago-relative.
    const storm = peer === "linux" && index >= 50 && index < 55;
    for (let k = 0; k < count; k++) {
      const start = Math.min(now - 5000, first + index * bucketMs + Math.floor(next() * bucketMs));
      const template = templates[Math.floor(next() * templates.length)]!;
      const ms = Math.round(template.ms[0] + (template.ms[1] - template.ms[0]) * next() ** 2.2);
      const roll = next();
      const failed = storm ? roll < 0.45 : roll < 0.02;
      const unknown = !failed && roll > 0.994;
      made.push(
        action(peer, start, template, {
          endedAt: start + ms,
          ...(failed
            ? next() < 0.3
              ? {
                  outcome: "error",
                  errorCode: "target_unavailable",
                  exitCode: null,
                  stdoutBytes: 0,
                }
              : { exitCode: [1, 1, 2, 127][Math.floor(next() * 4)]!, stderrBytes: 180 }
            : unknown
              ? {
                  outcome: "unknown_outcome",
                  errorCode: "unknown_outcome",
                  exitCode: null,
                  stdoutBytes: 0,
                }
              : { stdoutBytes: Math.floor(next() * 48_000) }),
        }),
      );
    }
  });
  return made;
}

const generated = [...generate("linux", linux, 2400, 7), ...generate("mac", mac, 900, 11)].sort(
  (a, b) => a.startedAt - b.startedAt,
);
for (const row of generated) rows.push({ ...row, id: nextId++ });
rows.push(
  action("linux", now - 20_000, linux[1]!, {
    id: nextId++,
    endedAt: null,
    outcome: null,
    exitCode: null,
    stdoutBytes: 0,
  }),
);
rows.push(
  action("mac", now - 25 * minute, mac[0]!, {
    id: nextId++,
    action: "copy",
    mode: "copy",
    command: null,
    args: null,
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
);
rows.sort((a, b) => a.id - b.id);

function resultOf(row: NodeActionRow) {
  if (row.endedAt === null) return "running";
  if (row.outcome === "ok")
    return (row.exitCode ?? 0) === 0 && !row.signal ? "succeeded" : "failed";
  return row.outcome === "error" ? "failed" : "no_result";
}

function inRange(row: NodeActionRow, params: Record<string, unknown>) {
  return (
    (typeof params.since !== "number" || row.startedAt >= params.since) &&
    (typeof params.until !== "number" || row.startedAt < params.until) &&
    (!params.peer || row.peer === params.peer)
  );
}

function answer(method: unknown, params: Record<string, unknown>): unknown {
  if (method === "node.status") return status;
  if (method === "events.subscribe" || method === "events.unsubscribe")
    return { subscribed: method === "events.subscribe" };
  if (method === "log.query" && params.kind === "actions") {
    const text = typeof params.text === "string" ? params.text.toLowerCase() : null;
    const limit = typeof params.limit === "number" ? params.limit : 100;
    const matched: NodeActionRow[] = [];
    for (let index = rows.length - 1; index >= 0 && matched.length <= limit; index--) {
      const item = rows[index]!;
      if (
        (typeof params.before !== "number" || item.id < params.before) &&
        inRange(item, params) &&
        (!Array.isArray(params.result) || params.result.includes(resultOf(item))) &&
        (!text ||
          [item.command, JSON.stringify(item.args), item.cwd]
            .join(" ")
            .toLowerCase()
            .includes(text))
      )
        matched.push(item);
    }
    return { rows: matched.slice(0, limit), hasMore: matched.length > limit };
  }
  if (
    method === "log.stats" &&
    typeof params.since === "number" &&
    typeof params.bucketMs === "number"
  ) {
    const until = typeof params.until === "number" ? params.until : Date.now();
    const groups = new Map<
      string,
      { peer: string | null; bucket: number; result: string; count: number }
    >();
    for (const row of rows) {
      if (!inRange(row, { ...params, until })) continue;
      const bucket = Math.floor((row.startedAt - params.since) / params.bucketMs);
      const result = resultOf(row);
      const key = `${row.peer}|${bucket}|${result}`;
      const group = groups.get(key) ?? { peer: row.peer, bucket, result, count: 0 };
      group.count++;
      groups.set(key, group);
    }
    return { since: params.since, until, bucketMs: params.bucketMs, groups: [...groups.values()] };
  }
  return undefined;
}

function send(client: { send(data: string): void }, event: NodeEvent) {
  client.send(JSON.stringify({ jsonrpc: "2.0", method: "events.node", params: event }));
}

export const nodeConsoleHandlers = [
  nodeConsole.addEventListener("connection", ({ client }) => {
    // A command starts on the workstation every few seconds and ends a moment later.
    const live = setInterval(() => {
      const row = action("linux", Date.now(), linux[Math.floor(Math.random() * 4)]!, {
        id: nextId++,
        endedAt: null,
        outcome: null,
        exitCode: null,
        stdoutBytes: 0,
      });
      rows.push(row);
      send(client, { type: "action", id: row.id, phase: "start", row });
      setTimeout(() => {
        Object.assign(row, { endedAt: Date.now(), outcome: "ok", exitCode: 0, stdoutBytes: 1024 });
        send(client, { type: "action", id: row.id, phase: "end", row: { ...row } });
      }, 1500);
    }, 6000);
    client.addEventListener("close", () => clearInterval(live));
    client.addEventListener("message", (event) => {
      let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const params = message.params ?? {};
      if (message.method === "events.subscribe" && params.topic === "node")
        send(client, {
          type: "snapshot",
          status,
          running: rows.filter((row) => row.endedAt === null),
        });
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

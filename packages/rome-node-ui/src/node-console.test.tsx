import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { NodeConsole, scriptOf, summarize } from "./node-console.js";
import type { NodeActionRow, NodeStatus } from "./protocol.js";

const status: NodeStatus = {
  version: "0.1.3",
  startedAt: Date.now() - 60_000,
  roles: {
    caller: {
      auth: "authorized",
      connection: "online",
      since: Date.now() - 30_000,
      reconnects: 2,
      running: 0,
    },
  },
};

function row(id: number, fields: Partial<NodeActionRow> = {}): NodeActionRow {
  return {
    id,
    direction: "out",
    peer: "dev-1",
    action: "exec",
    mode: "json",
    command: "git",
    args: ["status"],
    cwd: null,
    startedAt: Date.now() - 10_000,
    endedAt: Date.now() - 9_000,
    outcome: "ok",
    errorCode: null,
    exitCode: 0,
    signal: null,
    stdinBytes: 0,
    stdoutBytes: 10,
    stderrBytes: 0,
    transfer: null,
    ...fields,
  };
}

type Message = { id: number; method: string; params: Record<string, unknown> };

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  static reply: (socket: FakeSocket, message: Message) => void = () => {};
  readyState = 0;
  sent: Message[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(text: string) {
    const message = JSON.parse(text) as Message;
    this.sent.push(message);
    FakeSocket.reply(this, message);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function serve(history: NodeActionRow[]) {
  FakeSocket.reply = (socket, message) => {
    const respond = (result: unknown) => socket.emit({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "events.subscribe") {
      socket.emit({
        jsonrpc: "2.0",
        method: "events.node",
        params: { type: "snapshot", status, running: [] },
      });
      respond({ subscribed: true });
    } else if (message.method === "log.query") respond({ rows: history, hasMore: false });
    else if (message.method === "node.status") respond(status);
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
  rs.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const devices = [
  { id: "dev-1", name: "Workstation", platform: "linux", status: "connected" as const },
];

describe("NodeConsole", () => {
  it("shows the connection, history, and a script as code", async () => {
    serve([
      row(2, { command: "bash", args: ["-lc", "cd ~/rome\npnpm test"], exitCode: 1 }),
      row(1),
    ]);
    render(<NodeConsole url="ws://rome.test/ws/node" devices={devices} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    const history = await screen.findByRole("list", { name: "Sent commands" });
    expect(within(history).getByText("bash: cd ~/rome; pnpm test")).toBeTruthy();
    expect(within(history).getByText("Exit 1")).toBeTruthy();
    expect(within(history).getByText("git status")).toBeTruthy();
    await userEvent.click(within(history).getByText("bash: cd ~/rome; pnpm test"));
    expect(document.querySelector("pre code")?.textContent).toBe("cd ~/rome\npnpm test");
  });

  it("queries the daemon for a search and adds finished actions live", async () => {
    serve([row(1)]);
    render(<NodeConsole url="ws://rome.test/ws/node" devices={devices} />);
    await screen.findByRole("list", { name: "Sent commands" });
    const socket = FakeSocket.instances[0]!;
    await userEvent.type(screen.getByRole("searchbox", { name: "Search commands" }), "sta");
    await waitFor(() =>
      expect(socket.sent.some((message) => message.params.text === "sta")).toBe(true),
    );
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search commands" }));
    await waitFor(() =>
      expect(
        socket.sent.filter((message) => message.params.kind === "actions").at(-1)?.params,
      ).not.toHaveProperty("text"),
    );
    act(() =>
      socket.emit({
        jsonrpc: "2.0",
        method: "events.node",
        params: {
          type: "action",
          id: 3,
          phase: "end",
          row: row(3, { command: "uptime", args: [] }),
        },
      }),
    );
    expect(
      await within(screen.getByRole("list", { name: "Sent commands" })).findByText("uptime"),
    ).toBeTruthy();
  });

  it("connects to the given URL and shows Chinese for a zh locale", async () => {
    serve([row(1)]);
    render(<NodeConsole url="wss://example.test/console" devices={devices} locale="zh-CN" />);
    expect(await screen.findByText("已连接")).toBeTruthy();
    expect(FakeSocket.instances[0]!.url).toBe("wss://example.test/console");
    expect(await screen.findByRole("list", { name: "已发送的命令" })).toBeTruthy();
  });

  it("explains a missing daemon", async () => {
    FakeSocket.reply = () => {};
    render(<NodeConsole url="ws://rome.test/ws/node" devices={devices} />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => {
      socket.emit({ jsonrpc: "2.0", method: "console.daemon", params: { state: "not_running" } });
      socket.close();
    });
    expect(
      await screen.findByText("The device service is not running, so no activity is recorded."),
    ).toBeTruthy();
  });
});

describe("summarize", () => {
  it("names scripts, argv, and copies", () => {
    expect(
      scriptOf(row(1, { command: "pwsh.exe", args: ["-NoProfile", "-Command", "dir"] })),
    ).toEqual({ shell: "pwsh", script: "dir" });
    expect(summarize(row(1, { command: "echo", args: ["a b", "c"] }))).toBe('echo "a b" c');
    expect(
      summarize(
        row(1, {
          action: "copy",
          mode: "copy",
          command: null,
          args: null,
          transfer: {
            direction: "pull",
            localPath: "/l",
            remotePath: "/r",
            bytes: 1,
            sha256: null,
          },
        }),
      ),
    ).toBe("/r → /l");
  });
});

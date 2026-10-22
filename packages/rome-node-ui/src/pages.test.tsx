import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { NodeDeviceActivity } from "./device-activity.js";
import { NodeDeviceCard, NodeDevices } from "./devices-overview.js";
import type { NodeActionRow, NodeConnectionStatus, NodeStatus } from "./protocol.js";
import type { NodeDevice, NodeNavigation, NodeThisDevice } from "./types.js";

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
    cwd: "/home/dev/rome",
    startedAt: Date.now() - 10_000 - id,
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

/** Answers like a daemon holding `rows`. Without `stats`, log.stats is an unknown method. */
function serve(
  rows: NodeActionRow[],
  { stats = true, connection = "online" as NodeConnectionStatus } = {},
) {
  FakeSocket.reply = (socket, message) => {
    const respond = (result: unknown) => socket.emit({ jsonrpc: "2.0", id: message.id, result });
    const { method, params } = message;
    if (method === "events.subscribe") {
      socket.emit({
        jsonrpc: "2.0",
        method: "events.node",
        params: {
          type: "snapshot",
          status: { ...status, roles: { caller: { ...status.roles.caller!, connection } } },
          running: [],
        },
      });
      respond({ subscribed: true });
    } else if (method === "log.query") {
      const matched = rows.filter(
        (item) =>
          (!params.peer || item.peer === params.peer) &&
          (typeof params.before !== "number" || item.id < params.before) &&
          (!Array.isArray(params.result) ||
            params.result.includes(item.exitCode === 0 ? "succeeded" : "failed")),
      );
      respond({ rows: matched.slice(0, Number(params.limit ?? 100)), hasMore: false });
    } else if (method === "log.stats") {
      if (!stats) {
        socket.emit({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      const since = Number(params.since);
      const bucketMs = Number(params.bucketMs);
      const until = since + 144 * bucketMs;
      respond({
        since,
        until,
        bucketMs,
        groups: rows
          .filter((item) => !params.peer || item.peer === params.peer)
          .map((item) => ({
            peer: item.peer,
            bucket: Math.min(143, Math.floor((item.startedAt - since) / bucketMs)),
            result: item.exitCode === 0 ? "succeeded" : "failed",
            count: 1,
          })),
      });
    } else if (method === "node.status") respond(status);
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

const devices: NodeDevice[] = [
  { id: "dev-1", name: "Workstation", platform: "linux", status: "connected" },
  { id: "dev-2", name: "Laptop", platform: "darwin", status: "not_connected" },
  { id: "dev-3", name: "Old phone", platform: "ios", status: "revoked" },
];

function navigation(): NodeNavigation & { navigate: ReturnType<typeof rs.fn> } {
  return {
    href: (device, command) =>
      device === null ? "/devices" : `/devices/${device}${command ? `?command=${command}` : ""}`,
    navigate: rs.fn(),
  };
}

describe("NodeDevices", () => {
  it("gives active devices a card and links them to their page", async () => {
    serve([row(3, { exitCode: 1, command: "pnpm", args: ["test"] }), row(2), row(1)]);
    const nav = navigation();
    render(<NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={nav} />);
    const active = await screen.findByRole("region", { name: "Active devices" });
    expect(within(active).getByText("Workstation")).toBeTruthy();
    expect(within(active).getByText("33.3% failed")).toBeTruthy();
    const latest = await within(active).findByText("pnpm test");
    expect(latest.closest("a")?.getAttribute("href")).toBe("/devices/dev-1?command=3");
    await userEvent.click(within(active).getByText("View all activity"));
    expect(nav.navigate).toHaveBeenCalledWith("/devices/dev-1");
    // The idle device gets a compact card, and the revoked one waits behind a toggle.
    expect(screen.getByText("No commands in 24 h")).toBeTruthy();
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.queryByText("Old phone")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Revoked/ }));
    expect(screen.getByText("Old phone")).toBeTruthy();
  });

  it("lists devices without counts when the daemon predates log.stats", async () => {
    serve([row(1)], { stats: false });
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    expect(
      await screen.findByText("Restart the device service to show command counts."),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Active devices" })).toBeNull();
    expect(screen.getByText("Workstation")).toBeTruthy();
  });

  it("says nothing about a healthy service and names a Gateway problem", async () => {
    serve([]);
    const { unmount } = render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    await screen.findByText("Workstation");
    await waitFor(() => expect(FakeSocket.instances[0]?.sent.length).toBeGreaterThan(0));
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    serve([], { connection: "retrying" });
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    expect((await screen.findByRole("status")).textContent).toBe("Reconnecting to Gateway");
  });

  it("draws the device groups once, after the counts arrive", async () => {
    serve([row(2), row(1)]);
    const answer = FakeSocket.reply;
    const held: Array<() => void> = [];
    FakeSocket.reply = (socket, message) => {
      if (message.method === "log.stats" || message.method === "log.query")
        held.push(() => answer(socket, message));
      else answer(socket, message);
    };
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.queryByText("Workstation")).toBeNull();
    expect(screen.queryByText("No commands in 24 h")).toBeNull();
    act(() => held.shift()!());
    const active = await screen.findByRole("region", { name: "Active devices" });
    expect(screen.getByText("Laptop")).toBeTruthy();
    // Blank rows hold the latest commands' place until they arrive.
    await waitFor(() => expect(held).toHaveLength(1));
    expect(active.querySelectorAll("ul[aria-hidden] > li")).toHaveLength(3);
    act(() => held.shift()!());
    expect(await within(active).findAllByText("git status")).toHaveLength(2);
    expect(active.querySelector("ul[aria-hidden]")).toBeNull();
  });

  it("lists the devices when the socket closes before any counts", async () => {
    FakeSocket.reply = () => {};
    rs.stubGlobal(
      "WebSocket",
      class extends FakeSocket {
        constructor(url: string) {
          super(url);
          queueMicrotask(() => this.close());
        }
      },
    );
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    expect(await screen.findByText("Workstation")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Active devices" })).toBeNull();
  });

  it("waits for the host's devices", async () => {
    serve([]);
    const { rerender } = render(
      <NodeDevices url="ws://rome.test/ws/node" devices={[]} navigation={navigation()} loading />,
    );
    await waitFor(() => expect(FakeSocket.instances[0]?.sent.length).toBeGreaterThan(1));
    expect(screen.queryByText("No computers are linked to this account.")).toBeNull();
    rerender(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    expect(await screen.findByText("Workstation")).toBeTruthy();
  });

  it("opens the link instructions", async () => {
    serve([]);
    render(<NodeDevices url="ws://rome.test/ws/node" devices={[]} navigation={navigation()} />);
    await userEvent.click(screen.getByRole("button", { name: "Link device" }));
    expect(await screen.findByRole("dialog", { name: "Link a computer" })).toBeTruthy();
    expect(screen.getByText("rome-node connect")).toBeTruthy();
  });
});

describe("this device", () => {
  function self(fields: Partial<NodeThisDevice> = {}) {
    return {
      id: "dev-2",
      name: "Laptop.local",
      platform: "macos",
      state: "connected",
      onEnabledChange: rs.fn(),
      ...fields,
    } satisfies NodeThisDevice;
  }
  const more: NodeDevice[] = [
    { id: "dev-0", name: "Build server", platform: "linux", status: "not_connected" },
    ...devices,
  ];

  it("flags its own card, puts it first, and turns it off from there", async () => {
    serve([]);
    const thisDevice = self();
    render(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={more}
        navigation={navigation()}
        thisDevice={thisDevice}
      />,
    );
    const quiet = await screen.findByRole("region", { name: "No commands in 24 h" });
    const cards = within(quiet).getAllByRole("link");
    // The account's name wins over the app's, and the app's state over the account's.
    expect(within(cards[0]!).getByText("Laptop")).toBeTruthy();
    expect(within(cards[0]!).getByText("This device")).toBeTruthy();
    expect(within(cards[0]!).getByText("macOS · Connected")).toBeTruthy();
    expect(screen.getAllByText("This device")).toHaveLength(1);
    const toggle = screen.getByRole("switch", { name: "Let Rome use this device" });
    expect(toggle.closest("a")).toBeNull();
    await userEvent.click(toggle);
    expect(thisDevice.onEnabledChange).toHaveBeenCalledWith(false);
  });

  it("puts it first among active devices", async () => {
    serve([row(3), row(2), row(1, { peer: "dev-2" })]);
    render(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={devices}
        navigation={navigation()}
        thisDevice={self()}
      />,
    );
    const active = await screen.findByRole("region", { name: "Active devices" });
    await within(active).findByText("Workstation");
    const names = within(active)
      .getAllByRole("link", { name: /macOS|Linux/ })
      .map((link) => link.textContent);
    expect(names[0]).toContain("This device");
    expect(within(active).getByRole("switch")).toBeTruthy();
  });

  it("shows a computer the account does not list yet, turned off", async () => {
    serve([]);
    const thisDevice = self({ id: "new-mac", name: "RayBook", state: "disabled" });
    render(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={devices}
        navigation={navigation()}
        thisDevice={thisDevice}
      />,
    );
    expect(await screen.findByText("RayBook")).toBeTruthy();
    expect(screen.getByText("macOS · Turned off")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Let Rome use this device" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(thisDevice.onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("ignores the switch while a change is applied", async () => {
    serve([]);
    const thisDevice = self({ busy: true });
    render(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={devices}
        navigation={navigation()}
        thisDevice={thisDevice}
      />,
    );
    await userEvent.click(await screen.findByRole("switch"));
    expect(thisDevice.onEnabledChange).not.toHaveBeenCalled();
  });

  it("stands alone as a card and speaks Chinese", () => {
    render(
      <NodeDeviceCard
        device={{ id: "dev-2", name: "RayBook", platform: "macos" }}
        thisDevice={self({ state: "offline" })}
        locale="zh-CN"
      />,
    );
    expect(screen.getByText("本机")).toBeTruthy();
    expect(screen.getByText("macOS · 未连接")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "允许 Rome 使用本机" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("NodeDeviceActivity", () => {
  it("counts, filters by result, and shows the selected command", async () => {
    serve([
      row(3, { exitCode: 1, command: "bash", args: ["-lc", "cd ~/rome\npnpm test"] }),
      row(2),
      row(1),
    ]);
    const onSelect = rs.fn();
    render(
      <NodeDeviceActivity
        url="ws://rome.test/ws/node"
        device={devices[0]!}
        selected={null}
        onSelect={onSelect}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Workstation" })).toBeTruthy();
    expect(await screen.findByText("cd ~/rome; pnpm test")).toBeTruthy();
    const filter = screen.getByRole("radiogroup", { name: "Result" });
    expect(within(filter).getByRole("radio", { name: /Failed/ }).textContent).toContain("1");
    await userEvent.click(within(filter).getByRole("radio", { name: /Failed/ }));
    const socket = FakeSocket.instances[0]!;
    await waitFor(() =>
      expect(
        socket.sent.some(
          (message) =>
            message.method === "log.query" &&
            JSON.stringify(message.params.result) === JSON.stringify(["failed"]),
        ),
      ).toBe(true),
    );
    await userEvent.click(await screen.findByText("cd ~/rome; pnpm test"));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("shows a selected command in detail and updates it live", async () => {
    const running = row(5, { endedAt: null, outcome: null, exitCode: null });
    serve([running]);
    render(<NodeDeviceActivity url="ws://rome.test/ws/node" device={devices[0]!} selected={5} />);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Running")).toBeTruthy();
    expect(sheet.querySelector("pre code")?.textContent).toBe("git status");
    act(() =>
      FakeSocket.instances[0]!.emit({
        jsonrpc: "2.0",
        method: "events.node",
        params: {
          type: "action",
          id: 5,
          phase: "end",
          row: { ...running, endedAt: Date.now(), outcome: "ok", exitCode: 0 },
        },
      }),
    );
    expect(await within(sheet).findByText("exit 0")).toBeTruthy();
  });
});

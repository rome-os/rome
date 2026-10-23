import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { NodeDeviceActivity } from "./device-activity.js";
import { NodeDeviceCard, NodeDevices } from "./devices-overview.js";
import type { NodeActionRow, NodeConnectionStatus, NodeStatus } from "./protocol.js";
import type {
  NodeDevice,
  NodeDeviceManage,
  NodeDeviceManageError,
  NodeNavigation,
  NodeThisDevice,
} from "./types.js";

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
  it("lists every device with a curve of its commands and links it to its page", async () => {
    serve([row(3, { exitCode: 1 }), row(2), row(1)]);
    const nav = navigation();
    render(<NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={nav} />);
    const cards = await screen.findAllByRole("listitem");
    expect(cards.map((card) => card.textContent)).toEqual([
      "WorkstationLinux · Connected",
      "LaptopmacOS · Not connected",
    ]);
    expect(within(cards[0]!).getByRole("img", { name: "3 commands in 24 h" })).toBeTruthy();
    expect(within(cards[1]!).getByRole("img", { name: "0 commands in 24 h" })).toBeTruthy();
    await userEvent.click(screen.getByText("Workstation"));
    expect(nav.navigate).toHaveBeenCalledWith("/devices/dev-1");
    // The revoked device waits behind a toggle.
    expect(screen.queryByText("Old phone")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Revoked/ }));
    expect(screen.getByText("Old phone")).toBeTruthy();
  });

  it("shows no card for activity from a device the account does not list", async () => {
    serve([row(2), row(1, { peer: "removed-device" })]);
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    await screen.findByText("Workstation");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("removed-device")).toBeNull();
  });

  it("lists devices without counts when the daemon predates log.stats", async () => {
    serve([row(1)], { stats: false });
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    expect(
      await screen.findByText("Restart the device service to show command counts."),
    ).toBeTruthy();
    expect(screen.getByText("Workstation")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
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

  it("draws the devices once, after the counts arrive", async () => {
    serve([row(2), row(1)]);
    const answer = FakeSocket.reply;
    const held: Array<() => void> = [];
    FakeSocket.reply = (socket, message) => {
      if (message.method === "log.stats") held.push(() => answer(socket, message));
      else answer(socket, message);
    };
    render(
      <NodeDevices url="ws://rome.test/ws/node" devices={devices} navigation={navigation()} />,
    );
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.queryByText("Workstation")).toBeNull();
    act(() => held.shift()!());
    expect(await screen.findByRole("img", { name: "2 commands in 24 h" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "0 commands in 24 h" })).toBeTruthy();
  });

  it("orders devices once: connected first, then by their latest command", async () => {
    const hour = 60 * 60 * 1000;
    serve([
      row(1, { peer: "dev-b", startedAt: Date.now() - 5 * hour }),
      row(2, { peer: "dev-c", startedAt: Date.now() - 2 * hour }),
    ]);
    const list: NodeDevice[] = [
      { id: "dev-a", name: "Idle", platform: "linux", status: "not_connected" },
      { id: "dev-b", name: "Older", platform: "linux", status: "not_connected" },
      { id: "dev-c", name: "Newer", platform: "linux", status: "not_connected" },
      { id: "dev-d", name: "Online", platform: "linux", status: "connected" },
    ];
    const names = () =>
      screen.getAllByRole("listitem").map((card) => within(card).getAllByText(/./)[0]!.textContent);
    const { rerender } = render(
      <NodeDevices url="ws://rome.test/ws/node" devices={list} navigation={navigation()} />,
    );
    await screen.findByText("Online");
    expect(names()).toEqual(["Online", "Newer", "Older", "Idle"]);
    expect(screen.getAllByRole("img", { name: "1 command in 24 h" })).toHaveLength(2);
    // A change of connection updates the card in place, and a new device goes last.
    rerender(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={[
          { ...list[0]!, status: "connected" },
          ...list.slice(1, 3),
          { ...list[3]!, status: "not_connected" },
          { id: "dev-e", name: "New", platform: "linux", status: "connected" },
        ]}
        navigation={navigation()}
      />,
    );
    expect(names()).toEqual(["Online", "Newer", "Older", "Idle", "New"]);
    expect(
      within(screen.getAllByRole("listitem")[0]!).getByText("Linux · Not connected"),
    ).toBeTruthy();
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
    expect(screen.getByText("Laptop")).toBeTruthy();
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
      removeUrl: "https://cloud.test/dashboard/settings",
      onEnabledChange: rs.fn(),
      ...fields,
    } satisfies NodeThisDevice;
  }
  const more: NodeDevice[] = [
    { id: "dev-0", name: "Build server", platform: "linux", status: "not_connected" },
    ...devices,
  ];

  it("flags its own card, puts it first, and disconnects it from its menu", async () => {
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
    await screen.findByText("Build server");
    const cards = screen.getAllByRole("link");
    // The account's name wins over the app's, and the app's state over the account's.
    expect(within(cards[0]!).getByText("Laptop")).toBeTruthy();
    expect(within(cards[0]!).getByText("This device")).toBeTruthy();
    expect(within(cards[0]!).getByText("macOS · Connected")).toBeTruthy();
    expect(screen.getAllByText("This device")).toHaveLength(1);
    const menu = within(screen.getAllByRole("listitem")[0]!).getByRole("button", {
      name: "Device actions",
    });
    expect(menu.closest("a")).toBeNull();
    await userEvent.click(menu);
    // This computer is removed on Rome Cloud, so the menu links there.
    const remove = await screen.findByRole("menuitem", { name: "Remove on Rome Cloud" });
    expect(remove.getAttribute("href")).toBe("https://cloud.test/dashboard/settings");
    expect(remove.getAttribute("target")).toBe("_blank");
    await userEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Laptop?" });
    expect(within(dialog).getByText(/connect it again here at any time/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(thisDevice.onEnabledChange).toHaveBeenCalledWith(false);
  });

  it("puts it first even when other devices are busier", async () => {
    serve([row(3), row(2), row(1, { peer: "dev-2", startedAt: Date.now() - 5 * 60 * 60 * 1000 })]);
    render(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={devices}
        navigation={navigation()}
        thisDevice={self()}
      />,
    );
    await screen.findByText("Workstation");
    const cards = screen.getAllByRole("listitem");
    expect(cards[0]!.textContent).toContain("This device");
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
    await userEvent.click(screen.getByRole("button", { name: "Device actions" }));
    // Connecting again needs no confirmation.
    await userEvent.click(await screen.findByRole("menuitem", { name: "Connect" }));
    expect(thisDevice.onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("ignores connect and disconnect while a change is applied", async () => {
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
    await userEvent.click(await screen.findByRole("button", { name: "Device actions" }));
    const item = await screen.findByRole("menuitem", { name: "Disconnect" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
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
    expect(screen.getByRole("button", { name: "设备操作" })).toBeTruthy();
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

describe("device menu", () => {
  const manage = () => ({
    rename: rs.fn(
      async (_id: string, _name: string): Promise<NodeDeviceManageError | null> => null,
    ),
    remove: rs.fn(async (_id: string): Promise<NodeDeviceManageError | null> => null),
  });
  function page(device: NodeDevice, actions?: NodeDeviceManage) {
    serve([]);
    render(
      <NodeDeviceActivity
        url="ws://rome.test/ws/node"
        device={device}
        selected={null}
        manage={actions}
      />,
    );
  }
  const open = async () =>
    userEvent.click(await screen.findByRole("button", { name: "Device actions" }));

  it("has no menu without manage", async () => {
    page(devices[0]!);
    expect(await screen.findByRole("heading", { name: "Workstation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Device actions" })).toBeNull();
  });

  it("renames with the trimmed name and closes the dialog", async () => {
    const actions = manage();
    page(devices[0]!, actions);
    await open();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "  Build box  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(actions.rename).toHaveBeenCalledWith("dev-1", "Build box");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull());
  });

  it("keeps the rename dialog open with Cloud's reason", async () => {
    const actions = manage();
    actions.rename.mockResolvedValue("invalid_device_name");
    page(devices[0]!, actions);
    await open();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Use 1 to 80 characters without control characters."),
    ).toBeTruthy();
  });

  it("removes another device in one step after warning that it cannot be undone", async () => {
    const actions = manage();
    page(devices[0]!, actions);
    await open();
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Workstation?" });
    expect(within(dialog).getByText("This can't be undone.")).toBeTruthy();
    expect(within(dialog).getByText("Your agent can't use Workstation anymore.")).toBeTruthy();
    expect(within(dialog).getByText(/It returns as a new device/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(actions.remove).toHaveBeenCalledWith("dev-1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers a revoked device only removal and explains a pending revocation", async () => {
    const actions = manage();
    actions.remove.mockResolvedValue("revocation_pending");
    page(devices[2]!, actions);
    await open();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Old phone?" });
    expect(within(dialog).getByText(/already revoked/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/It stays under Revoked/)).toBeTruthy();
  });

  it("puts a menu on each card, over its link", async () => {
    serve([]);
    const actions = manage();
    render(
      <NodeDevices
        url="ws://rome.test/ws/node"
        devices={devices}
        navigation={navigation()}
        manage={actions}
      />,
    );
    await screen.findByText("Workstation");
    const menus = screen.getAllByRole("button", { name: "Device actions" });
    expect(menus).toHaveLength(2);
    expect(menus[0]!.closest("a")).toBeNull();
    await userEvent.click(menus[1]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    expect(actions.remove).toHaveBeenCalledWith("dev-2");
  });
});

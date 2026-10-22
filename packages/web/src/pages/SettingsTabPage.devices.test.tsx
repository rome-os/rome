// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import type { DesktopDeviceStatus } from "@/lib/electron-shell";
import DeviceActivityPage from "./DeviceActivityPage";
import SettingsPage from "./SettingsTabPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderDevices(load: () => unknown, start?: () => Response | Promise<Response>) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === "/api/devices/start" && init?.method === "POST" && start) return start();
    if (String(input) === "/api/devices")
      return new Response(JSON.stringify(await load()), {
        headers: { "Content-Type": "application/json" },
      });
    return new Response("{}", { status: 503 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings/devices"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  /** Reads the devices again, as the 15-second poll does. */
  return { client, poll: () => act(() => client.refetchQueries({ queryKey: ["node-devices"] })) };
}

it("lists devices independently of the settings request", async () => {
  renderDevices(() => ({
    connection: "online",
    checkedAt: new Date().toISOString(),
    devices: [
      { id: "one", name: "MacBook", platform: "macos", status: "connected" },
      { id: "two", name: "Desktop", platform: "linux", status: "not_connected" },
      { id: "three", name: "Old computer", platform: "windows", status: "revoked" },
    ],
  }));
  expect(await screen.findByText("Linux · Not connected")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe(
    "/settings/devices",
  );
  expect(screen.getByRole("link", { name: /Desktop/ }).getAttribute("href")).toBe(
    "/settings/devices/two",
  );
  // A revoked device waits behind its toggle.
  expect(screen.queryByText("Old computer")).toBeNull();
});

it("shows a device that could not be checked as unknown", async () => {
  renderDevices(() => ({
    connection: "online",
    checkedAt: new Date().toISOString(),
    devices: [
      { id: "one", name: "MacBook", platform: "macos", status: "connected" },
      { id: "two", name: "Desktop", platform: "linux", status: "unknown" },
    ],
  }));
  expect(await screen.findByText("Linux · Unknown")).toBeTruthy();
});

it("drops the device list when a later read cannot reach the service", async () => {
  let failed = false;
  const { poll } = renderDevices(() =>
    failed
      ? { connection: "unavailable", checkedAt: new Date().toISOString(), devices: [] }
      : {
          connection: "online",
          checkedAt: new Date().toISOString(),
          devices: [{ id: "mac", name: "Mac", platform: "macos", status: "connected" }],
        },
  );
  expect(await screen.findByText("Mac")).toBeTruthy();
  failed = true;
  await poll();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Mac")).toBeNull();
});

it("holds the devices page in place while the first read is pending", async () => {
  renderDevices(() => new Promise(() => {}));
  expect(await screen.findByRole("button", { name: "Link device" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Devices" })).toBeTruthy();
  // The service-recovery page waits for an answer that says the service needs it.
  expect(screen.queryByRole("heading", { name: "Connect a computer" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});

it("keeps the listed devices when a later read fails", async () => {
  let failed = false;
  const { client, poll } = renderDevices(() => {
    if (failed) throw new Error("offline");
    return {
      connection: "online",
      checkedAt: new Date().toISOString(),
      devices: [{ id: "mac", name: "Mac", platform: "macos", status: "connected" }],
    };
  });
  expect(await screen.findByText("Mac")).toBeTruthy();
  failed = true;
  await poll();
  await waitFor(() => expect(client.getQueryState(["node-devices"])?.status).toBe("error"));
  // Let the page render the failed read before checking it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(screen.getByText("Mac")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("explains missing authorization instead of reporting zero devices", async () => {
  renderDevices(() => ({
    connection: "not_configured",
    checkedAt: new Date().toISOString(),
    devices: [],
  }));
  expect(await screen.findByText("Not configured")).toBeTruthy();
});

it("drops the device list when the service stops and does not start it on its own", async () => {
  let running = true;
  const { poll } = renderDevices(() =>
    running
      ? {
          connection: "online",
          checkedAt: new Date().toISOString(),
          devices: [{ id: "mac", name: "Mac", platform: "macos", status: "connected" }],
        }
      : { connection: "not_running", checkedAt: new Date().toISOString(), devices: [] },
  );
  expect(await screen.findByText("Mac")).toBeTruthy();
  running = false;
  await poll();
  expect(await screen.findByText("Service not running")).toBeTruthy();
  expect(
    screen.getByText("Start the service on this Rome instance to check linked computers."),
  ).toBeTruthy();
  expect(screen.queryByText("Mac")).toBeNull();
  expect(screen.getByRole("button", { name: "Start service" })).toBeTruthy();
  expect(
    rs.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
  ).toBe(true);
});

it("offers computer setup for an idle running service without an error", async () => {
  renderDevices(() => ({
    connection: "stopped",
    checkedAt: new Date().toISOString(),
    devices: [],
  }));
  expect(await screen.findByText("No computers are linked to this account.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Link device" }));
  expect(await screen.findByText("rome-node connect")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start service" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("starts only on explicit click and refreshes server truth after success", async () => {
  let running = false;
  let finish!: () => void;
  const start = rs.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = () => {
          running = true;
          resolve(new Response(null, { status: 204 }));
        };
      }),
  );
  renderDevices(
    () => ({
      connection: running ? "stopped" : "not_running",
      checkedAt: new Date().toISOString(),
      devices: [],
    }),
    start,
  );
  const button = await screen.findByRole("button", { name: "Start service" });
  expect(screen.getByRole("heading", { name: "Connect a computer" })).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
  await userEvent.click(button);
  const pending = await screen.findByRole("button", { name: "Starting…" });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(pending);
  expect(start).toHaveBeenCalledTimes(1);
  finish();
  expect(await screen.findByText("No computers are linked to this account.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start service" })).toBeNull();
});

it.each([
  ["start_failed", "Could not start the device service"],
  [
    "not_configured",
    "Device access is not configured. Link this Rome instance to Rome Cloud to prepare access.",
  ],
  [
    "incompatible",
    "On the Rome instance, run rome-node daemon stop, then rome-node daemon start. This restarts the shared service and interrupts device requests in progress.",
  ],
])("shows actionable startup errors without automatic retries (%s)", async (error, message) => {
  const start = rs.fn(() => new Response(JSON.stringify({ error }), { status: 503 }));
  renderDevices(
    () => ({
      connection: "not_running",
      checkedAt: new Date().toISOString(),
      devices: [],
    }),
    start,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Start service" }));
  expect((await screen.findByRole("alert")).textContent).toBe(message);
  expect(start).toHaveBeenCalledTimes(1);
});

it("localizes the service recovery and computer setup in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    renderDevices(() => ({
      connection: "not_running",
      checkedAt: new Date().toISOString(),
      devices: [],
    }));
    expect(await screen.findByRole("button", { name: "启动服务" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "连接电脑" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "安装与连接指南" })).toBeTruthy();
  } finally {
    cleanup();
    await i18n.changeLanguage("en");
  }
});

it("opens a device's page with the selected command from the URL", async () => {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input) === "/api/devices"
      ? new Response(
          JSON.stringify({
            connection: "online",
            checkedAt: new Date().toISOString(),
            devices: [{ id: "one", name: "MacBook", platform: "macos", status: "connected" }],
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      : new Response("{}", { status: 503 }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings/devices/one?command=3"]}>
        <Routes>
          <Route path="/settings/devices/:deviceId" element={<DeviceActivityPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("heading", { name: "MacBook" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe(
    "/settings/devices",
  );
});

describe("this device in the Mac app", () => {
  const online = () => ({
    connection: "online",
    checkedAt: new Date().toISOString(),
    devices: [{ id: "this-mac", name: "RayBook", platform: "macos", status: "connected" }],
  });

  function installBridge() {
    let listener: ((status: DesktopDeviceStatus) => void) | null = null;
    const bridge = {
      get: rs.fn(
        async (): Promise<DesktopDeviceStatus> => ({
          state: "connected",
          deviceId: "this-mac",
          name: "RayBook.local",
        }),
      ),
      setEnabled: rs.fn(
        async (enabled: boolean): Promise<DesktopDeviceStatus> => ({
          state: enabled ? "connecting" : "disabled",
          deviceId: "this-mac",
          name: "RayBook.local",
        }),
      ),
      onStatus: rs.fn((callback: (status: DesktopDeviceStatus) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      }),
    };
    window.rome = { device: bridge };
    return { bridge, push: (status: DesktopDeviceStatus) => listener?.(status) };
  }

  afterEach(() => {
    delete window.rome;
  });

  it("flags this computer's card under its Rome Cloud name and turns it off", async () => {
    const { bridge } = installBridge();
    renderDevices(online);
    const toggle = await screen.findByRole("switch", { name: "Let Rome use this device" });
    // One card: the flag sits on the account's device, not on a card of its own.
    expect(screen.getAllByText("This device")).toHaveLength(1);
    expect(screen.getAllByText("RayBook")).toHaveLength(1);
    expect(screen.getByText("macOS · Connected")).toBeTruthy();
    await userEvent.click(toggle);
    expect(bridge.setEnabled).toHaveBeenCalledWith(false);
    expect(await screen.findByText("macOS · Turned off")).toBeTruthy();
  });

  it("follows the status the app pushes", async () => {
    const { push } = installBridge();
    renderDevices(online);
    await screen.findByText("macOS · Connected");
    act(() => push({ state: "offline", deviceId: "this-mac", name: "RayBook.local" }));
    expect(await screen.findByText("macOS · Not connected")).toBeTruthy();
  });

  it("shows nothing in a browser or in an app without device controls", async () => {
    renderDevices(online);
    await screen.findByText("RayBook");
    expect(screen.queryByText("This device")).toBeNull();
    cleanup();
    window.rome = {};
    renderDevices(online);
    await screen.findByText("RayBook");
    expect(screen.queryByText("This device")).toBeNull();
  });
});

// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
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
      return new Response(JSON.stringify(load()), {
        headers: { "Content-Type": "application/json" },
      });
    return new Response("{}", { status: 503 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings/devices"]}>
        <Routes>
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("counts connected devices, not authorized records, independently of the settings request", async () => {
  renderDevices(() => ({
    connection: "online",
    checkedAt: new Date().toISOString(),
    devices: [
      { id: "one", name: "MacBook", platform: "macos", status: "connected" },
      { id: "two", name: "Desktop", platform: "linux", status: "not_connected" },
      { id: "three", name: "Old computer", platform: "windows", status: "revoked" },
    ],
  }));
  expect(await screen.findByText("1 of 2 online")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe(
    "/settings/devices",
  );
  expect(screen.getByText("Linux · Not connected")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Desktop/ }).getAttribute("href")).toBe(
    "/settings/devices/two",
  );
  // A revoked device waits behind its toggle.
  expect(screen.queryByText("Old computer")).toBeNull();
});

it("reports a lower bound when some devices could not be checked", async () => {
  renderDevices(() => ({
    connection: "online",
    checkedAt: new Date().toISOString(),
    devices: [
      { id: "one", name: "MacBook", platform: "macos", status: "connected" },
      { id: "two", name: "Desktop", platform: "linux", status: "unknown" },
    ],
  }));
  expect(await screen.findByText("at least 1 of 2 online")).toBeTruthy();
  expect(screen.getByText("Linux · Unknown")).toBeTruthy();
});

it("clears a previous connected count when refreshing cannot read status", async () => {
  let failed = false;
  renderDevices(() =>
    failed
      ? { connection: "unavailable", checkedAt: new Date().toISOString(), devices: [] }
      : {
          connection: "online",
          checkedAt: new Date().toISOString(),
          devices: [{ id: "mac", name: "Mac", platform: "macos", status: "connected" }],
        },
  );
  expect(await screen.findByText("1 of 1 online")).toBeTruthy();
  failed = true;
  await userEvent.click(screen.getByRole("button", { name: "Check connections now" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/online/)).toBeNull();
});

it("explains missing authorization instead of reporting zero devices", async () => {
  renderDevices(() => ({
    connection: "not_configured",
    checkedAt: new Date().toISOString(),
    devices: [],
  }));
  expect(await screen.findByText("Not configured")).toBeTruthy();
  expect(screen.queryByText(/online/)).toBeNull();
});

it("clears device counts when the service stops and keeps refresh passive", async () => {
  let running = true;
  renderDevices(() =>
    running
      ? {
          connection: "online",
          checkedAt: new Date().toISOString(),
          devices: [{ id: "mac", name: "Mac", platform: "macos", status: "connected" }],
        }
      : { connection: "not_running", checkedAt: new Date().toISOString(), devices: [] },
  );
  expect(await screen.findByText("1 of 1 online")).toBeTruthy();
  running = false;
  await userEvent.click(screen.getByRole("button", { name: "Check connections now" }));
  expect(await screen.findByText("Service not running")).toBeTruthy();
  expect(
    screen.getByText(
      "Start the service on this Rome instance to check linked computers. Refresh only checks status; it does not start the service.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/online/)).toBeNull();
  expect(screen.queryByText("Mac")).toBeNull();
  expect(screen.getByRole("button", { name: "Start service" })).toBeTruthy();
  expect(
    rs.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
  ).toBe(true);
});

it("does not present zero as the connected count when every check is unknown", async () => {
  renderDevices(() => ({
    connection: "retrying",
    checkedAt: new Date().toISOString(),
    devices: [{ id: "mac", name: "Mac", platform: "macos", status: "unknown" }],
  }));
  expect(await screen.findByText("Mac")).toBeTruthy();
  expect(screen.getByText("macOS · Unknown")).toBeTruthy();
  expect(screen.queryByText(/online/)).toBeNull();
});

it("offers computer setup for an idle running service without an error", async () => {
  renderDevices(() => ({
    connection: "stopped",
    checkedAt: new Date().toISOString(),
    devices: [],
  }));
  expect(await screen.findByText("No computers are linked to this account.")).toBeTruthy();
  expect(screen.getByText("0 of 0 online")).toBeTruthy();
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
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
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
  expect(screen.queryByText(/online/)).toBeNull();
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

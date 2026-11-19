// @rstest-environment jsdom
// @rstest-environment-options {"url":"http://rome.localhost:9443/settings/devices"}
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ContainerNode } from "@rome/api-types/devices";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import type { DesktopDeviceStatus } from "@/lib/electron-shell";
import DeviceActivityPage from "./DeviceActivityPage";
import SettingsDialog from "./SettingsDialog";
import SettingsPage from "./SettingsTabPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderDevices(
  load: () => unknown,
  start?: () => Response | Promise<Response>,
  containerNodes?: (path: string, init?: RequestInit) => Response,
) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === "/api/devices/start" && init?.method === "POST" && start) return start();
    if (String(input) === "/api/devices")
      return new Response(JSON.stringify(await load()), {
        headers: { "Content-Type": "application/json" },
      });
    if (String(input).startsWith("/api/devices/container-nodes")) {
      return (
        containerNodes?.(String(input), init) ?? Response.json({ nodes: [], transport: "direct" })
      );
    }
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
  expect(screen.queryByRole("heading", { name: "Connect a device" })).toBeNull();
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

it("shows the three connection cards on an empty devices page", async () => {
  renderDevices(() => ({
    connection: "stopped",
    checkedAt: new Date().toISOString(),
    devices: [],
  }));
  const setup = within(await screen.findByRole("region", { name: "Connect a device" }));
  expect(
    setup.getByRole("heading", { name: "Desktop/iOS client" }).closest('[data-slot="card"]'),
  ).toBeTruthy();
  expect(
    setup.getByRole("heading", { name: "Rome Node CLI" }).closest('[data-slot="card"]'),
  ).toBeTruthy();
  expect(
    setup.getByRole("heading", { name: "Rome Node container" }).closest('[data-slot="card"]'),
  ).toBeTruthy();
  expect(await setup.findByRole("button", { name: "Generate Compose" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Link device" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start service" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("opens the selected connection instructions directly in the dialog", async () => {
  renderDevices(() => ({
    connection: "online",
    checkedAt: new Date().toISOString(),
    devices: [{ id: "mac", name: "MacBook", platform: "macos", status: "connected" }],
  }));
  await screen.findByRole("link", { name: /MacBook/ });
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Link device" });
  const choices = [
    ["Desktop/iOS client", "Download Rome", "https://romeos.cc/download"],
    ["Rome Node CLI", "rome-node connect"],
    ["Rome Node container", "Generate Compose"],
  ];
  for (const [name, content, href] of choices) {
    await user.click(trigger);
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(
      choices.map(([label]) => label),
    );
    await user.click(menu.getByRole("menuitem", { name }));
    const dialog = await screen.findByRole("dialog", { name });
    const action = await within(dialog).findByText(content);
    expect(action).toBeTruthy();
    if (href) expect(action.getAttribute("href")).toBe(href);
    expect(dialog.querySelector('[data-slot="card"]')).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }
  expect(screen.getByRole("link", { name: /MacBook/ })).toBeTruthy();
});

it("reopens the original Compose while the node is waiting for deployment", async () => {
  const path = "/api/devices/container-nodes";
  const id = "73426989-9646-4579-9869-af5a321ff48d";
  const projectName = "rome-node-73426989964645799869";
  const installToken = `romeinstall_${"A".repeat(43)}`;
  const grant = {
    id,
    installToken,
    origin: window.location.origin,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let nodes: unknown[] = [];
  const containerNodes = rs.fn((url: string, init?: RequestInit) => {
    if (url === path && init?.method !== "POST")
      return Response.json({ nodes, transport: "direct" });
    if (url === `${path}/${id}/compose`) return Response.json(grant);
    if (url === `${path}/${id}` && init?.method === "PATCH") {
      nodes = [{ id, deviceId: null, name: "Renamed NAS", status: "waiting" }];
      return new Response(null, { status: 204 });
    }
    nodes = [{ id, deviceId: null, name: "Hall NAS", status: "waiting" }];
    return Response.json(grant);
  });
  const { client } = renderDevices(
    () => ({
      connection: "online",
      checkedAt: new Date().toISOString(),
      devices: [{ id: "one", name: "MacBook", platform: "macos", status: "connected" }],
    }),
    undefined,
    containerNodes,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Link device" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rome Node container" }));
  const setup = within(await screen.findByRole("dialog", { name: "Rome Node container" }));
  expect(setup.queryByRole("combobox")).toBeNull();
  fireEvent.change(await setup.findByLabelText("Node name"), { target: { value: "Hall NAS" } });
  const address = setup.getByRole("textbox", { name: "Rome address" });
  const generate = setup.getByRole("button", { name: "Generate Compose" });
  expect(address).toHaveProperty("value", window.location.origin);
  expect(address.getAttribute("aria-invalid")).toBeNull();
  expect(generate).toHaveProperty("disabled", false);
  fireEvent.change(address, { target: { value: "" } });
  expect(address).toHaveProperty("value", "");
  fireEvent.change(address, { target: { value: "http://rome.example:9443" } });
  expect(address.getAttribute("aria-invalid")).toBeNull();
  await user.click(generate);
  expect(address.getAttribute("aria-invalid")).toBe("true");
  expect(containerNodes.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  fireEvent.change(address, { target: { value: window.location.origin } });
  expect(address.getAttribute("aria-invalid")).toBeNull();
  await user.click(generate);
  expect(containerNodes).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      body: JSON.stringify({ name: "Hall NAS", origin: window.location.origin }),
      method: "POST",
    }),
  );
  expect(await setup.findByText(projectName)).toBeTruthy();
  const preview = setup.getByRole("region", { name: "Compose configuration" });
  expect(setup.getByRole("button", { name: "Download Compose" })).toBeTruthy();
  expect(setup.queryByRole("button", { name: "Add another node" })).toBeNull();
  await user.click(setup.getByRole("button", { name: "Copy Compose" }));
  const compose = await navigator.clipboard.readText();
  expect(preview.textContent).toBe(compose);
  expect(compose).toContain('image: "ghcr.io/rome-os/rome-node:latest"');
  expect(compose).toContain(`ROME_NODE_CLOUD_URL: "${window.location.origin}"`);
  expect(compose).toContain(`ROME_NODE_INSTALLATION_ID: "${id}"`);
  expect(compose).toContain(`ROME_NODE_INSTALL_TOKEN: "${installToken}"`);
  expect(compose).toContain(`rome-node-${id}-state`);
  expect(compose).not.toMatch(/ports:|privileged:|network_mode:|extra_hosts:/);
  expect(containerNodes.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(setup.queryByText("Waiting for deployment")).toBeNull();

  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "Link device" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rome Node container" }));
  const reopened = within(await screen.findByRole("dialog", { name: "Rome Node container" }));
  expect(await reopened.findByLabelText("Node name")).toHaveProperty("value", "Container node");
  expect(reopened.getByLabelText("Rome address")).toHaveProperty("value", window.location.origin);
  expect(reopened.queryByRole("region", { name: "Compose configuration" })).toBeNull();
  expect(containerNodes.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

  await user.keyboard("{Escape}");
  const devices = within(await screen.findByRole("list", { name: "Devices" }));
  expect(devices.getByRole("link", { name: /MacBook/ })).toBeTruthy();
  const pending = within((await devices.findByText("Hall NAS")).closest("li")!);
  expect(pending.getByText("Waiting for deployment")).toBeTruthy();
  expect(pending.queryByRole("link")).toBeNull();
  await user.click(pending.getByRole("button", { name: "Device actions" }));
  expect(await screen.findByRole("menuitem", { name: "Remove" })).toBeTruthy();
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  const rename = within(await screen.findByRole("dialog", { name: "Rename device" }));
  fireEvent.change(rename.getByRole("textbox"), { target: { value: "Renamed NAS" } });
  await user.click(rename.getByRole("button", { name: "Save" }));
  await user.click(await devices.findByRole("button", { name: /Renamed NAS/ }));
  const deployment = within(await screen.findByRole("dialog", { name: "Renamed NAS" }));
  expect(deployment.getByText("Waiting for deployment")).toBeTruthy();
  expect(
    (await deployment.findByRole("region", { name: "Compose configuration" })).textContent,
  ).toBe(compose);
  expect(deployment.queryByRole("textbox")).toBeNull();
  expect(deployment.getByRole("button", { name: "Download Compose" })).toBeTruthy();
  expect(containerNodes.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

  nodes = [{ id, deviceId: null, name: "Renamed NAS", status: "needs_pairing" }];
  await act(() => client.refetchQueries({ queryKey: ["container-nodes"] }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Renamed NAS" })).toBeNull());
  expect(devices.queryByText("Renamed NAS")).toBeNull();
  expect(screen.getByRole("button", { name: "Link device" })).toBeTruthy();
}, 15_000);

it("opens Compose when generating the first container node with the service stopped", async () => {
  const path = "/api/devices/container-nodes";
  const id = "73426989-9646-4579-9869-af5a321ff48d";
  const grant = {
    id,
    installToken: `romeinstall_${"A".repeat(43)}`,
    origin: "https://rome.example",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let nodes: ContainerNode[] = [];
  renderDevices(
    () => ({ connection: "not_running", checkedAt: new Date().toISOString(), devices: [] }),
    undefined,
    (url, init) => {
      if (url === `${path}/${id}/compose`) return Response.json(grant);
      if (init?.method === "POST") {
        nodes = [{ id, deviceId: null, name: "First node", status: "waiting" }];
        return Response.json(grant, { status: 201 });
      }
      return Response.json({ nodes, transport: "direct" });
    },
  );
  const user = userEvent.setup();
  const setup = within(await screen.findByRole("region", { name: "Connect a device" }));
  fireEvent.change(await setup.findByLabelText("Node name"), { target: { value: "First node" } });
  fireEvent.change(setup.getByLabelText("Rome address"), { target: { value: grant.origin } });
  await user.click(setup.getByRole("button", { name: "Generate Compose" }));
  const firstPreview = within(await screen.findByRole("dialog", { name: "First node" }));
  expect(
    (await firstPreview.findByRole("region", { name: "Compose configuration" })).textContent,
  ).toContain(grant.installToken);
  await user.keyboard("{Escape}");

  const devices = within(await screen.findByRole("list", { name: "Devices" }));
  expect(devices.getByText("First node")).toBeTruthy();
  expect(devices.getByText("Waiting for deployment")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Link device" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start service" })).toBeTruthy();

  const card = devices.getByRole("button", { name: /First node/ });
  card.focus();
  await user.keyboard("{Enter}");
  const dialog = within(await screen.findByRole("dialog", { name: "First node" }));
  expect(dialog.getByText("Waiting for deployment")).toBeTruthy();
  expect(await dialog.findByRole("region", { name: "Compose configuration" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(card));
});

it("keeps one direct container card while device and installation reads arrive in either order", async () => {
  const installationId = "73426989-9646-4579-9869-af5a321ff48d";
  const deviceId = "06954fc4-5a06-4dc8-898d-cffac7ac97a1";
  const name = "Lab container";
  let node: ContainerNode = { id: installationId, deviceId: null, name, status: "waiting" };
  let listed = true;
  const { client, poll } = renderDevices(
    () => ({
      connection: "not_running",
      checkedAt: new Date().toISOString(),
      devices: listed
        ? [{ id: deviceId, installationId, name, platform: "linux", status: "connected" }]
        : [],
    }),
    undefined,
    () => Response.json({ nodes: [node], transport: "direct" }),
  );
  const devices = within(await screen.findByRole("list", { name: "Devices" }));
  await devices.findByRole("button", { name: /Lab container/ });
  await poll();
  expect(devices.getAllByRole("listitem")).toHaveLength(1);
  expect(devices.queryByRole("link", { name: /Lab container/ })).toBeNull();

  listed = false;
  await poll();
  node = { ...node, deviceId, status: "online" };
  await act(() => client.refetchQueries({ queryKey: ["container-nodes"] }));
  const link = await devices.findByRole("link", { name: /Lab container/ });
  expect(link.getAttribute("href")).toBe(`/settings/devices/${deviceId}`);
  expect(devices.getAllByRole("listitem")).toHaveLength(1);

  listed = true;
  await poll();
  node = { ...node, deviceId: null, status: "needs_pairing" };
  await act(() => client.refetchQueries({ queryKey: ["container-nodes"] }));
  await waitFor(() => expect(screen.queryByText(name)).toBeNull());
  expect(await screen.findByRole("heading", { name: "Connect a device" })).toBeTruthy();
});

it("hides a revoked Cloud container while the devices snapshot still lists it", async () => {
  const deviceId = "06954fc4-5a06-4dc8-898d-cffac7ac97a1";
  const name = "Revoked container";
  const { client } = renderDevices(
    () => ({
      connection: "online",
      checkedAt: new Date().toISOString(),
      devices: [
        { id: "one", name: "MacBook", platform: "macos", status: "connected" },
        { id: deviceId, name, platform: "linux", status: "connected" },
      ],
    }),
    undefined,
    () =>
      Response.json({
        transport: "cloud",
        nodes: [
          { id: "73426989-9646-4579-9869-af5a321ff48d", deviceId, name, status: "needs_pairing" },
        ],
      }),
  );
  await screen.findByRole("link", { name: /MacBook/ });
  await act(() => client.refetchQueries({ queryKey: ["container-nodes"] }));
  await waitFor(() => expect(screen.queryByText(name)).toBeNull());
});

it("explains when the Cloud installer is unavailable", async () => {
  renderDevices(
    () => ({
      connection: "online",
      checkedAt: new Date().toISOString(),
      devices: [{ id: "one", name: "MacBook", platform: "macos", status: "connected" }],
    }),
    undefined,
    () => Response.json({ error: "cloud_unsupported" }, { status: 501 }),
  );

  await userEvent.click(screen.getByRole("button", { name: "Link device" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rome Node container" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Rome Node container" }));
  expect((await dialog.findByRole("alert")).textContent).toBe(
    "Container node deployment is unavailable on this Rome Cloud.",
  );
  expect(dialog.queryByRole("button", { name: "Generate Compose" })).toBeNull();
});

it("removes an unpaired installation after confirmation and keeps paired devices listed", async () => {
  const path = "/api/devices/container-nodes";
  const id = "73426989-9646-4579-9869-af5a321ff48d";
  const paired = {
    id: "3dc4a001-183f-4170-b150-1e2c0c792d72",
    deviceId: "06954fc4-5a06-4dc8-898d-cffac7ac97a1",
    name: "Paired node",
    status: "offline",
  };
  let nodes = [{ id, deviceId: null, name: "Abandoned node", status: "waiting" }, paired];
  const containerNodes = rs.fn((url: string, init?: RequestInit) => {
    if (url === `${path}/${id}` && init?.method === "DELETE") {
      nodes = [paired];
      return new Response(null, { status: 204 });
    }
    return Response.json({ nodes, transport: "direct" });
  });
  renderDevices(
    () => ({
      connection: "not_running",
      checkedAt: new Date().toISOString(),
      devices: [
        { id: paired.deviceId, name: paired.name, platform: "linux", status: "not_connected" },
      ],
    }),
    undefined,
    containerNodes,
  );
  const user = userEvent.setup();
  const devices = within(await screen.findByRole("list", { name: "Devices" }));
  const pairedCard = within(
    (await devices.findByRole("link", { name: /Paired node/ })).closest("li")!,
  );
  await user.click(pairedCard.getByRole("button", { name: "Device actions" }));
  expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
  await user.keyboard("{Escape}");
  const pending = within((await devices.findByText("Abandoned node")).closest("li")!);
  await user.click(pending.getByRole("button", { name: "Device actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirmation = within(
    await screen.findByRole("dialog", { name: "Remove Abandoned node?" }),
  );
  await user.click(confirmation.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(devices.queryByText("Abandoned node")).toBeNull());
  expect(devices.getByRole("link", { name: /Paired node/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Link device" })).toBeTruthy();
  expect(containerNodes).toHaveBeenCalledWith(
    `${path}/${id}`,
    expect.objectContaining({ method: "DELETE" }),
  );
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
  const connection = screen.getByRole("heading", { name: "Rome connection" });
  expect(connection.closest('[data-slot="card"]')).toBeNull();
  expect(screen.getByRole("heading", { name: "Connect a device" })).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
  await userEvent.click(button);
  const pending = await screen.findByRole("button", { name: "Starting…" });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(pending);
  expect(start).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Start service" })).toBeNull());
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

it("localizes the service recovery and device setup in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  try {
    renderDevices(() => ({
      connection: "not_running",
      checkedAt: new Date().toISOString(),
      devices: [],
    }));
    expect(await screen.findByRole("button", { name: "启动服务" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "连接设备" })).toBeTruthy();
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

it("steps back to the devices list on Escape, leaving Settings open", async () => {
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
  const close = rs.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings/devices/one"]}>
        <SettingsDialog onClose={close}>
          <Routes>
            <Route path="/settings/devices/:deviceId" element={<DeviceActivityPage />} />
            <Route path="/settings/devices" element={<p>Devices list</p>} />
          </Routes>
        </SettingsDialog>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "MacBook" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(await screen.findByText("Devices list")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});

describe("managing a device from its page", () => {
  function renderDevice(
    device: Record<string, unknown>,
    answer: (method: string, url: string) => Response = () => new Response(null, { status: 204 }),
  ) {
    const requests: { method: string; url: string; body: unknown }[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/devices")
        return new Response(
          JSON.stringify({
            connection: "online",
            checkedAt: new Date().toISOString(),
            devices: [{ id: "one", name: "MacBook", platform: "macos", ...device }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      if (url.startsWith("/api/devices/one")) {
        const method = init?.method ?? "GET";
        requests.push({
          method,
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return answer(method, url);
      }
      return new Response("{}", { status: 503 });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/settings/devices/one"]}>
          <Routes>
            <Route path="/settings/devices/:deviceId" element={<DeviceActivityPage />} />
            <Route path="/settings/devices" element={<p>Devices list</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return requests;
  }
  const menu = async (item: string) => {
    await screen.findByRole("heading", { name: "MacBook" });
    await userEvent.click(await screen.findByRole("button", { name: "Device actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("sends a rename to the backend", async () => {
    const requests = renderDevice({ status: "connected" });
    await menu("Rename");
    const field = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Studio");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(requests).toEqual([
        { method: "PATCH", url: "/api/devices/one", body: { name: "Studio" } },
      ]),
    );
  });

  it("removes a connected device in one request and returns to the list", async () => {
    const requests = renderDevice({ status: "connected" });
    await menu("Remove");
    const dialog = await screen.findByRole("dialog", { name: "Remove MacBook?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Devices list")).toBeTruthy();
    expect(requests).toEqual([{ method: "DELETE", url: "/api/devices/one", body: undefined }]);
  });

  it("keeps the dialog open while the revocation is unconfirmed", async () => {
    renderDevice(
      { status: "revoked" },
      () =>
        new Response(JSON.stringify({ error: "revocation_pending" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await menu("Remove");
    const dialog = await screen.findByRole("dialog", { name: "Remove MacBook?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/has not confirmed it yet/)).toBeTruthy();
    expect(screen.queryByText("Devices list")).toBeNull();
  });
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

  it("flags this computer's card under its Rome Cloud name and disconnects it", async () => {
    const { bridge } = installBridge();
    renderDevices(online);
    const menu = await screen.findByRole("button", { name: "Device actions" });
    // One card: the flag sits on the account's device, not on a card of its own.
    expect(screen.getAllByText("This device")).toHaveLength(1);
    expect(screen.getAllByText("RayBook")).toHaveLength(1);
    expect(screen.getByText("macOS · Connected")).toBeTruthy();
    await userEvent.click(menu);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    );
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

  it("draws the cards once the app names this computer, with it first", async () => {
    const { bridge } = installBridge();
    let answer: (status: DesktopDeviceStatus) => void = () => {};
    bridge.get.mockImplementation(
      () => new Promise<DesktopDeviceStatus>((resolve) => (answer = resolve)),
    );
    renderDevices(() => ({
      ...online(),
      devices: [
        { id: "work", name: "Workstation", platform: "linux", status: "connected" },
        ...online().devices,
      ],
    }));
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    // The devices are read, but the order waits for the app.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText("Workstation")).toBeNull();
    act(() => answer({ state: "connected", deviceId: "this-mac", name: "RayBook.local" }));
    await screen.findByText("Workstation");
    const cards = within(screen.getByRole("list", { name: "Devices" })).getAllByRole("listitem");
    expect(cards[0]!.textContent).toContain("This device");
    expect(cards[1]!.textContent).toContain("Workstation");
  });

  it("draws the devices when the app refuses this page", async () => {
    const { bridge } = installBridge();
    bridge.get.mockRejectedValue(new Error("device:get is not available to this page"));
    renderDevices(online);
    expect(await screen.findByText("RayBook")).toBeTruthy();
    expect(screen.queryByText("This device")).toBeNull();
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

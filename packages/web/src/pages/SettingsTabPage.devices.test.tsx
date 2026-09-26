// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import SettingsPage from "./SettingsTabPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderDevices(load: () => unknown) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
  expect(await screen.findByText("1 connected device")).toBeTruthy();
  expect(screen.getByText("2 authorized devices")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe(
    "/settings/devices",
  );
  expect(
    within(screen.getByRole("list", { name: "Devices" })).getByText("Not connected"),
  ).toBeTruthy();
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
  expect(await screen.findByText("At least 1 connected device")).toBeTruthy();
  expect(
    screen.getByText("The connection status of 1 device could not be confirmed."),
  ).toBeTruthy();
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
  expect(await screen.findByText("1 connected device")).toBeTruthy();
  failed = true;
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("1 connected device")).toBeNull();
  expect(screen.queryByText("0 connected devices")).toBeNull();
});

it("explains missing authorization instead of reporting zero devices", async () => {
  renderDevices(() => ({
    connection: "not_configured",
    checkedAt: new Date().toISOString(),
    devices: [],
  }));
  expect(await screen.findByText("Not configured")).toBeTruthy();
  expect(screen.queryByText("0 connected devices")).toBeNull();
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
  expect(await screen.findByText("1 connected device")).toBeTruthy();
  running = false;
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Service not running")).toBeTruthy();
  expect(
    screen.getByText("The device service is not running. Device connection status is unknown."),
  ).toBeTruthy();
  expect(screen.queryByText("1 connected device")).toBeNull();
  expect(screen.queryByText("0 connected devices")).toBeNull();
  expect(screen.queryByText("0 authorized devices")).toBeNull();
  expect(screen.queryByText("Mac")).toBeNull();
});

it("does not present zero as the connected count when every check is unknown", async () => {
  renderDevices(() => ({
    connection: "retrying",
    checkedAt: new Date().toISOString(),
    devices: [{ id: "mac", name: "Mac", platform: "macos", status: "unknown" }],
  }));
  expect(await screen.findByText("Reconnecting")).toBeTruthy();
  expect(screen.queryByText("At least 0 connected devices")).toBeNull();
  expect(screen.getByText("1 authorized device")).toBeTruthy();
});

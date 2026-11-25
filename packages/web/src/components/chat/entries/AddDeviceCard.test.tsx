// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderPlain, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { AddDeviceCard } from "./AddDeviceCard";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderPlain(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

/** Answers the device reads with the account's devices as Rome Cloud lists
 *  them: the status keeps revoked ones, the list drops them. */
function mockDevices(devices: Array<{ id: string; name: string; revoked?: true }>) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const listed = (path === "/api/devices/list" ? devices.filter((d) => !d.revoked) : devices).map(
      ({ id, name }) => ({ id, name, platform: "macos" }),
    );
    return {
      ok: true,
      status: 200,
      json: async () =>
        path === "/api/devices/list"
          ? { devices: listed }
          : {
              connection: "online",
              checkedAt: "2026-11-24T09:00:00.000Z",
              devices: listed.map((device) => ({ ...device, status: "connected" })),
            },
    };
  }) as unknown as typeof fetch);
}

describe("AddDeviceCard", () => {
  it("shows the Devices page's ways to add a device, each with its instructions", async () => {
    mockDevices([{ id: "mac", name: "MacBook Pro" }]);
    const user = userEvent.setup();

    render(<AddDeviceCard widgetId="w-1" props={{ deviceIds: ["mac"] }} sendEvent={rs.fn()} />);

    expect(screen.getByText("Connect a device")).toBeTruthy();
    expect(screen.getByText("Waiting for a new device")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "App" }));
    expect(screen.getByRole("link", { name: "Download Rome" }).getAttribute("href")).toBe(
      "https://romeos.cc/download",
    );

    await user.click(screen.getByRole("button", { name: "Rome Node CLI" }));
    expect(screen.getByText("rome-node connect")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Installation and connection guide" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Rome Node container" }));
    expect(screen.getByText("Coming soon")).toBeTruthy();
  });

  it("asks core to answer once a device it did not know is linked", async () => {
    mockDevices([
      { id: "mac", name: "MacBook Pro" },
      { id: "new", name: "New laptop" },
    ]);
    const sendEvent = rs.fn(async () => ({ ok: true, status: 200, answered: true }));

    render(<AddDeviceCard widgetId="w-2" props={{ deviceIds: ["mac"] }} sendEvent={sendEvent} />);

    await waitFor(() => expect(sendEvent).toHaveBeenCalledWith("w-2", { name: "check", turn: {} }));
    expect(sendEvent).toHaveBeenCalledOnce();
    expect(await screen.findByText("Added New laptop")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
  });

  it("never takes a revoked device the account still lists for a new one", async () => {
    const fetchSpy = mockDevices([
      { id: "mac", name: "MacBook Pro" },
      { id: "old", name: "Old phone", revoked: true },
    ]);
    const sendEvent = rs.fn();

    render(<AddDeviceCard widgetId="w-7" props={{ deviceIds: ["mac"] }} sendEvent={sendEvent} />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendEvent).not.toHaveBeenCalled();
    expect(screen.getByText("Waiting for a new device")).toBeTruthy();
  });

  it("never asks on its own without the devices it was sent with", async () => {
    const fetchSpy = mockDevices([{ id: "new", name: "New laptop" }]);
    const sendEvent = rs.fn();

    render(<AddDeviceCard widgetId="w-3" props={{}} sendEvent={sendEvent} />);

    expect(screen.getByRole("button", { name: "App" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("brings back a way to ask again when core has not answered", async () => {
    mockDevices([{ id: "new", name: "New laptop" }]);
    const sendEvent = rs
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValue({ ok: true, status: 200, answered: true });

    render(<AddDeviceCard widgetId="w-4" props={{ deviceIds: [] }} sendEvent={sendEvent} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));
    expect(sendEvent).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Added New laptop")).toBeTruthy();
  });

  it("is dismissed by Not now", async () => {
    mockDevices([{ id: "mac", name: "MacBook Pro" }]);
    const sendEvent = rs.fn(async () => ({ ok: true, status: 200, answered: true }));

    render(<AddDeviceCard widgetId="w-6" props={{ deviceIds: ["mac"] }} sendEvent={sendEvent} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Not now" }));
    expect(sendEvent).toHaveBeenCalledWith("w-6", { name: "dismiss", turn: {} });
    expect(await screen.findByText("No device added")).toBeTruthy();
  });

  it("renders a dismissed card read-only without reading the devices", () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");

    render(<AddDeviceCard widgetId="w-5" props={{ deviceIds: [] }} result={{ dismissed: true }} />);

    expect(screen.getByText("No device added")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

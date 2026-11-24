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

function mockDevices(devices: Array<{ id: string; name: string }>) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      connection: "online",
      checkedAt: "2026-11-24T09:00:00.000Z",
      devices: devices.map((device) => ({ ...device, platform: "macos", status: "connected" })),
    }),
  })) as unknown as typeof fetch);
}

describe("AddDeviceCard", () => {
  it("shows the Devices page's ways to add a device, each with its instructions", async () => {
    mockDevices([{ id: "mac", name: "MacBook Pro" }]);
    const user = userEvent.setup();

    render(<AddDeviceCard toolUseId="t-1" props={{ deviceIds: ["mac"] }} onSubmit={rs.fn()} />);

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

  it("answers once a device it did not know is linked", async () => {
    mockDevices([
      { id: "mac", name: "MacBook Pro" },
      { id: "new", name: "New laptop" },
    ]);
    const onSubmit = rs.fn();

    render(<AddDeviceCard toolUseId="t-2" props={{ deviceIds: ["mac"] }} onSubmit={onSubmit} />);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "t-2",
        { added: true, deviceId: "new", name: "New laptop" },
        "Added the device New laptop",
      ),
    );
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByText("Added New laptop")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
  });

  it("never answers on its own without the devices it was sent with", async () => {
    const fetchSpy = mockDevices([{ id: "new", name: "New laptop" }]);

    render(<AddDeviceCard toolUseId="t-3" props={{}} onSubmit={rs.fn()} />);

    expect(screen.getByRole("button", { name: "App" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("brings back a way to send an answer that did not go through", async () => {
    mockDevices([{ id: "new", name: "New laptop" }]);
    const onSubmit = rs
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);

    render(<AddDeviceCard toolUseId="t-4" props={{ deviceIds: [] }} onSubmit={onSubmit} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Added New laptop")).toBeTruthy();
  });

  it("renders a dismissed card read-only without reading the devices", () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");

    render(
      <AddDeviceCard
        toolUseId="t-5"
        props={{ deviceIds: [] }}
        result={{ dismissed: true }}
        onSubmit={rs.fn()}
      />,
    );

    expect(screen.getByText("No device added")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

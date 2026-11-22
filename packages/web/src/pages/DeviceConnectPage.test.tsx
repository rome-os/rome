// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import DeviceConnectPage from "./DeviceConnectPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  rs.restoreAllMocks();
  await i18n.changeLanguage("en");
});

const phoneDevice = {
  capability: "device",
  title: "Device",
  summary: "Your Rome reads this phone's battery and network.",
  labels: {
    "zh-CN": { title: "设备状态", summary: "你的 Rome 读取这部手机的电量和网络。" },
  },
  device: { name: "iPhone" },
  state: "off",
};

function renderAt(capability: string, response: Response, ...later: Response[]) {
  const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  for (const next of later) fetch.mockResolvedValueOnce(next);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/connections/device/${capability}`]}>
        <Routes>
          <Route path="/connections/device/:capability" element={<DeviceConnectPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const refused = () =>
  new Response(JSON.stringify({ error: "Guardian session required" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

const listing = (connections: unknown[]) =>
  new Response(JSON.stringify({ connections }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("DeviceConnectPage", () => {
  it("says what the capability does, where to turn it on, and that it is not for a computer", async () => {
    renderAt("device", listing([phoneDevice]));
    expect(await screen.findByRole("heading", { name: "Connect Device" })).toBeTruthy();
    expect(screen.getByText("Your Rome reads this phone's battery and network.")).toBeTruthy();
    expect(screen.getByText(/Connect Device on iPhone: open the Rome app there/)).toBeTruthy();
    expect(screen.getByText(/It doesn't add a computer/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Manage computers in Settings › Devices" })
        .getAttribute("href"),
    ).toBe("/settings/devices");
  });

  it("uses the device's words in the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    renderAt("device", listing([phoneDevice]));
    expect(await screen.findByRole("heading", { name: "连接 设备状态" })).toBeTruthy();
    expect(screen.getByText("你的 Rome 读取这部手机的电量和网络。")).toBeTruthy();
  });

  it("never pairs a translated name with an English summary", async () => {
    await i18n.changeLanguage("zh-CN");
    renderAt("device", listing([{ ...phoneDevice, labels: { "zh-CN": { title: "设备状态" } } }]));
    expect(await screen.findByRole("heading", { name: "连接 设备状态" })).toBeTruthy();
    expect(screen.queryByText("Your Rome reads this phone's battery and network.")).toBeNull();
  });

  it("says the list could not load instead of naming the capability by its id", async () => {
    renderAt("device", refused());
    expect(await screen.findByText("Connections couldn't be loaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect device" })).toBeNull();
  });

  it("keeps the loaded page when a later poll fails", async () => {
    const client = renderAt("device", listing([phoneDevice]), refused());
    expect(await screen.findByRole("heading", { name: "Connect Device" })).toBeTruthy();
    await act(async () => {
      await client.refetchQueries({ queryKey: ["device-connections"] });
      // React Query tells its observers on a timer, so let the page hear the failure.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(client.getQueryState(["device-connections"])?.status).toBe("error");
    expect(screen.getByRole("heading", { name: "Connect Device" })).toBeTruthy();
    expect(screen.queryByText("Connections couldn't be loaded")).toBeNull();
  });
});

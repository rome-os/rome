// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import { DeviceConnectSettled, isDeviceConnectCard } from "./DeviceConnectSettled";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("a device's answered connect card", () => {
  it("says Connected, or Not connected when it was put off, with no buttons", () => {
    render(<DeviceConnectSettled result={{ kind: "apple_health", status: "connected" }} />);
    expect(screen.getByText("Connected")).toBeTruthy();
    cleanup();
    render(<DeviceConnectSettled result={{ dismissed: true }} />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is only core's connect card for a device kind", () => {
    const render_ = { componentId: "connect-card", props: { kind: "apple_health", device: true } };
    expect(isDeviceConnectCard({ appId: "core", render: render_ })).toBe(true);
    expect(
      isDeviceConnectCard({ appId: "core", render: { ...render_, props: { kind: "github" } } }),
    ).toBe(false);
    expect(isDeviceConnectCard({ appId: "connector", render: render_ })).toBe(false);
  });
});

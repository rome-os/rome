import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { NodeThisDevice, type NodeThisDeviceProps } from "./this-device.js";

afterEach(cleanup);

function renderCard(props: Partial<NodeThisDeviceProps> = {}) {
  const onEnabledChange = rs.fn();
  render(
    <NodeThisDevice
      name="RayBook"
      platform="macos"
      state="connected"
      onEnabledChange={onEnabledChange}
      {...props}
    />,
  );
  return {
    onEnabledChange,
    toggle: screen.getByRole("switch", { name: "Let Rome use this device" }),
  };
}

describe("NodeThisDevice", () => {
  it("names this computer and says it is online", () => {
    const { toggle } = renderCard();
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByText("RayBook")).toBeTruthy();
    expect(screen.getByText("macOS · Online")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("asks the host to turn the device off", async () => {
    const { toggle, onEnabledChange } = renderCard();
    await userEvent.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it("shows a turned-off device as off and asks to turn it back on", async () => {
    const { toggle, onEnabledChange } = renderCard({ state: "disabled" });
    expect(screen.getByText("macOS · Turned off")).toBeTruthy();
    expect(screen.getByText(/can't reach this computer/)).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("ignores clicks while a change is applied", async () => {
    const { toggle, onEnabledChange } = renderCard({ busy: true });
    await userEvent.click(toggle);
    expect(onEnabledChange).not.toHaveBeenCalled();
  });

  it("speaks Chinese for a zh locale", () => {
    render(
      <NodeThisDevice
        name="RayBook"
        platform="macos"
        state="offline"
        locale="zh-CN"
        onEnabledChange={() => undefined}
      />,
    );
    expect(screen.getByText("本机")).toBeTruthy();
    expect(screen.getByText("macOS · 未连接")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "允许 Rome 使用本机" })).toBeTruthy();
  });
});

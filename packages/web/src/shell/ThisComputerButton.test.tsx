// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import type { DesktopDeviceStatus } from "@/lib/electron-shell";
import { ThisComputerButton } from "./ThisComputerButton";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  delete window.rome;
});

type DeviceState = Exclude<DesktopDeviceStatus, { state: "off" }>["state"];

const status = (state: DeviceState): DesktopDeviceStatus => ({
  state,
  deviceId: "d1",
  name: "Macbook",
});

function installBridge(initial: DesktopDeviceStatus, { auditLog = true } = {}) {
  let listener: ((next: DesktopDeviceStatus) => void) | null = null;
  const bridge = {
    get: rs.fn(async () => initial),
    setEnabled: rs.fn(async (enabled: boolean) => status(enabled ? "connecting" : "disabled")),
    openAuditLog: auditLog ? rs.fn(async () => undefined) : undefined,
    onStatus: rs.fn((callback: (next: DesktopDeviceStatus) => void) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
  };
  window.rome = { device: bridge };
  return { bridge, push: (next: DesktopDeviceStatus) => listener?.(next) };
}

const dot = () => document.querySelector('[data-slot="computer-dot"]');

describe("ThisComputerButton", () => {
  it("renders nothing in a browser", () => {
    const { container } = render(<ThisComputerButton />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing in an app without device controls, or while the app is signed out", async () => {
    window.rome = {};
    const bare = render(<ThisComputerButton />);
    expect(bare.container.innerHTML).toBe("");
    cleanup();

    const { bridge } = installBridge({ state: "off" });
    const { container } = render(<ThisComputerButton />);
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing until the app answers", async () => {
    const { bridge } = installBridge(status("connected"));
    let answer: (next: DesktopDeviceStatus) => void = () => {};
    bridge.get.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { container } = render(<ThisComputerButton />);
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    act(() => answer(status("connected")));
    expect(await screen.findByRole("button", { name: "Rome can use this computer" })).toBeTruthy();
  });

  it.each([
    ["connected", "Rome can use this computer", "bg-success"],
    ["connecting", "Connecting…", "bg-warning"],
    ["offline", "Rome can't reach this computer right now", "bg-subtle-foreground"],
    ["disabled", "Rome can't use this computer", null],
  ] as const)("labels the %s state and draws its dot", async (state, label, dotClass) => {
    installBridge(status(state));
    render(<ThisComputerButton />);
    const button = await screen.findByRole("button", { name: label });
    expect(button.hasAttribute("title")).toBe(false);
    if (dotClass) expect(dot()?.className).toContain(dotClass);
    else expect(dot()).toBeNull();
  });

  it.each([
    ["connected", "Rome can use this computer"],
    ["connecting", "Connecting…"],
    ["offline", "Rome can't reach this computer right now"],
    ["disabled", "Rome can't use this computer"],
  ] as const)("shows the %s label in a tooltip on hover", async (state, label) => {
    installBridge(status(state));
    render(<ThisComputerButton />);
    await userEvent.hover(await screen.findByRole("button", { name: label }));
    expect((await screen.findByRole("tooltip")).textContent).toBe(label);
  });

  it("shows the tooltip on keyboard focus", async () => {
    installBridge(status("connected"));
    render(<ThisComputerButton />);
    await screen.findByRole("button", { name: "Rome can use this computer" });
    await userEvent.tab();
    expect((await screen.findByRole("tooltip")).textContent).toBe("Rome can use this computer");
  });

  it("puts the tooltip on the side the rail asks for", async () => {
    installBridge(status("connected"));
    render(<ThisComputerButton tooltipSide="right" />);
    await userEvent.hover(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    await screen.findByRole("tooltip");
    expect(document.querySelector('[data-slot="tooltip-content"]')?.getAttribute("data-side")).toBe(
      "right",
    );
  });

  it("keeps the tooltip away while the popover is open and after it closes", async () => {
    installBridge(status("connected"));
    render(<ThisComputerButton />);
    const button = await screen.findByRole("button", { name: "Rome can use this computer" });
    await userEvent.click(button);
    await screen.findByRole("switch");
    await userEvent.hover(button);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Escape returns focus to the button, which must not open the tooltip.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("pulses the connecting dot only when motion is allowed", async () => {
    installBridge(status("connecting"));
    render(<ThisComputerButton />);
    await screen.findByRole("button", { name: "Connecting…" });
    expect(dot()?.className).toContain("motion-safe:animate-pulse");
  });

  it("follows the status the app pushes", async () => {
    const { push } = installBridge(status("connected"));
    render(<ThisComputerButton />);
    await screen.findByRole("button", { name: "Rome can use this computer" });
    act(() => push(status("offline")));
    expect(
      await screen.findByRole("button", { name: "Rome can't reach this computer right now" }),
    ).toBeTruthy();
  });

  it("shows the switch and state line, and turns the computer off", async () => {
    const { bridge } = installBridge(status("connected"));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    expect(await screen.findByText("Connected")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Let Rome use this computer" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(toggle);
    expect(bridge.setEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("turns a disabled computer on", async () => {
    const { bridge } = installBridge(status("disabled"));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can't use this computer" }),
    );
    expect(await screen.findByText("Turned off")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Let Rome use this computer" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(bridge.setEnabled).toHaveBeenCalledWith(true);
  });

  it("disables the switch while a change is applied", async () => {
    const { bridge } = installBridge(status("connected"));
    let finish: (next: DesktopDeviceStatus) => void = () => {};
    bridge.setEnabled.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    const toggle = await screen.findByRole("switch", { name: "Let Rome use this computer" });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(true));
    act(() => finish(status("disabled")));
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  });

  it("opens the audit log from the popover", async () => {
    const { bridge } = installBridge(status("connected"));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "View audit log" }));
    expect(bridge.openAuditLog).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
  });

  it("offers no audit log when the app does not", async () => {
    installBridge(status("connected"), { auditLog: false });
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    await screen.findByRole("switch");
    expect(screen.queryByText("View audit log")).toBeNull();
  });

  it("speaks Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      installBridge(status("offline"));
      render(<ThisComputerButton />);
      await userEvent.click(
        await screen.findByRole("button", { name: "Rome 暂时无法连接这台电脑" }),
      );
      expect(await screen.findByRole("switch", { name: "允许 Rome 操作这台电脑" })).toBeTruthy();
      expect(screen.getByText("离线")).toBeTruthy();
      expect(screen.getByText("查看操作记录")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

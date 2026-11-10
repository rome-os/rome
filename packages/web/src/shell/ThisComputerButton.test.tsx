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

/** What an app that always connects reports: the connection apart from Computer use. */
const split = (
  connection: "connected" | "connecting" | "offline",
  computerUse: boolean,
  notifications: boolean,
): DesktopDeviceStatus => ({
  state: computerUse ? connection : "disabled",
  deviceId: "d1",
  name: "Macbook",
  connection,
  computerUse,
  notifications,
});

function installBridge(
  initial: DesktopDeviceStatus,
  { auditLog = true, notifications = false } = {},
) {
  let listener: ((next: DesktopDeviceStatus) => void) | null = null;
  const bridge = {
    get: rs.fn(async () => initial),
    setEnabled: rs.fn(async (enabled: boolean) => status(enabled ? "connecting" : "disabled")),
    openAuditLog: auditLog ? rs.fn(async () => undefined) : undefined,
    setNotificationsEnabled: notifications
      ? rs.fn(async (enabled: boolean) => split("connected", false, enabled))
      : undefined,
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

  it("shows the switch and turns the computer off", async () => {
    const { bridge } = installBridge(status("connected"));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    const toggle = await screen.findByRole("switch", { name: "Computer use" });
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
    const toggle = await screen.findByRole("switch", { name: "Computer use" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(bridge.setEnabled).toHaveBeenCalledWith(true);
  });

  it("does not toggle when the title is clicked", async () => {
    const { bridge } = installBridge(status("connected"));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    await userEvent.click(await screen.findByText("Computer use"));
    expect(bridge.setEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("disables the switch while a change is applied", async () => {
    const { bridge } = installBridge(status("connected"));
    let finish: (next: DesktopDeviceStatus) => void = () => {};
    bridge.setEnabled.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<ThisComputerButton />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Rome can use this computer" }),
    );
    const toggle = await screen.findByRole("switch", { name: "Computer use" });
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
    await userEvent.click(await screen.findByRole("button", { name: "Computer use log" }));
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
    expect(screen.queryByText("Computer use log")).toBeNull();
  });

  it("speaks Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      installBridge(status("offline"));
      render(<ThisComputerButton />);
      await userEvent.click(
        await screen.findByRole("button", { name: "Rome 暂时无法连接这台电脑" }),
      );
      expect(await screen.findByRole("switch", { name: "电脑操作" })).toBeTruthy();
      expect(screen.getByText("电脑操作记录")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  describe("with an app that always connects", () => {
    it("says the connection and that Computer use is off", async () => {
      installBridge(split("connected", false, true), { notifications: true });
      render(<ThisComputerButton />);
      const button = await screen.findByRole("button", {
        name: "Connected · Computer use off",
      });
      // The icon keeps the look of a turned-off computer.
      expect(button).toBeTruthy();
      expect(dot()).toBeNull();
    });

    it.each([
      ["connecting", "Connecting… · Computer use off"],
      ["offline", "Offline · Computer use off"],
    ] as const)("labels a limited %s connection", async (connection, label) => {
      installBridge(split(connection, false, true), { notifications: true });
      render(<ThisComputerButton />);
      expect(await screen.findByRole("button", { name: label })).toBeTruthy();
    });

    it("keeps the old labels while Computer use is on", async () => {
      installBridge(split("connected", true, true), { notifications: true });
      render(<ThisComputerButton />);
      expect(
        await screen.findByRole("button", { name: "Rome can use this computer" }),
      ).toBeTruthy();
    });

    it("shows a Notifications switch under Computer use, and changes it", async () => {
      const { bridge } = installBridge(split("connected", false, true), { notifications: true });
      render(<ThisComputerButton />);
      await userEvent.click(await screen.findByRole("button", { name: /Computer use off/ }));
      const switches = await screen.findAllByRole("switch");
      expect(switches).toHaveLength(2);
      const computer = screen.getByRole("switch", { name: "Computer use" });
      const notifications = screen.getByRole("switch", { name: "Notifications" });
      expect(computer.getAttribute("aria-checked")).toBe("false");
      expect(notifications.getAttribute("aria-checked")).toBe("true");
      expect(
        computer.compareDocumentPosition(notifications) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await userEvent.click(notifications);
      expect(bridge.setNotificationsEnabled).toHaveBeenCalledWith(false);
      expect(bridge.setEnabled).not.toHaveBeenCalled();
      await waitFor(() => expect(notifications.getAttribute("aria-checked")).toBe("false"));
    });

    it("hides the Notifications switch when the app cannot change it", async () => {
      // The status carries the flag, but the bridge has no method for it.
      installBridge(split("connected", true, true));
      render(<ThisComputerButton />);
      await userEvent.click(
        await screen.findByRole("button", { name: "Rome can use this computer" }),
      );
      await screen.findByRole("switch");
      expect(screen.queryByRole("switch", { name: "Notifications" })).toBeNull();
    });

    it("hides the Notifications switch when the status does not report it", async () => {
      // An app that predates the choice: a method without the flag does not make a switch.
      installBridge(status("connected"), { notifications: true });
      render(<ThisComputerButton />);
      await userEvent.click(
        await screen.findByRole("button", { name: "Rome can use this computer" }),
      );
      await screen.findByRole("switch");
      expect(screen.getAllByRole("switch")).toHaveLength(1);
    });

    it("disables both switches while a change is applied", async () => {
      const { bridge } = installBridge(split("connected", true, true), { notifications: true });
      let finish: (next: DesktopDeviceStatus) => void = () => {};
      bridge.setNotificationsEnabled?.mockImplementation(
        () => new Promise((resolve) => (finish = resolve)),
      );
      render(<ThisComputerButton />);
      await userEvent.click(
        await screen.findByRole("button", { name: "Rome can use this computer" }),
      );
      const notifications = await screen.findByRole("switch", { name: "Notifications" });
      await userEvent.click(notifications);
      await waitFor(() => expect(notifications.hasAttribute("disabled")).toBe(true));
      expect(screen.getByRole("switch", { name: "Computer use" }).hasAttribute("disabled")).toBe(
        true,
      );
      act(() => finish(split("connected", true, false)));
      await waitFor(() => expect(notifications.hasAttribute("disabled")).toBe(false));
    });

    it("speaks Chinese", async () => {
      await i18n.changeLanguage("zh-CN");
      try {
        installBridge(split("connected", false, true), { notifications: true });
        render(<ThisComputerButton />);
        await userEvent.click(
          await screen.findByRole("button", { name: "已连接 · 电脑操作已关闭" }),
        );
        expect(await screen.findByRole("switch", { name: "通知" })).toBeTruthy();
      } finally {
        await i18n.changeLanguage("en");
      }
    });
  });
});

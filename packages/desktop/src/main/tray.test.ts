import { EventEmitter } from "events";
import { describe, expect, it, rs } from "@rstest/core";

const menus = rs.hoisted(() => [] as Electron.MenuItemConstructorOptions[][]);

rs.mock("electron", () => ({
  app: { on: rs.fn() },
  BrowserWindow: class {},
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      menus.push(template);
      return template;
    },
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ setTemplateImage() {} }),
  },
}));
rs.mock("./lifecycle", () => ({ isQuitting: () => false, requestStopAndQuit: rs.fn() }));
rs.mock("./logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import type { RuntimeStatus } from "./runtime/provider";
import type { Runtime } from "./runtime/runtime";
import type { DeviceStatus } from "./cloud/device-host";
import { deviceLabel, setupTray, statusLabel } from "./tray";

function status(partial: Partial<RuntimeStatus>): RuntimeStatus {
  return {
    phase: "starting_rome",
    title: "",
    detail: "",
    primaryAction: "none",
    dashboardUrl: "https://ray.romeos.cc",
    lastError: null,
    ...partial,
  };
}

describe("statusLabel", () => {
  it("names the Rome Cloud states", () => {
    expect(statusLabel(null)).toBe("Status: Starting…");
    expect(statusLabel(status({ phase: "ready" }))).toBe("Status: Ready");
    expect(statusLabel(status({ phase: "waiting_for_user", primaryAction: "sign_in" }))).toBe(
      "Status: Not signed in",
    );
    expect(
      statusLabel(status({ phase: "waiting_for_user", primaryAction: "choose_instance" })),
    ).toBe("Status: Waiting for you");
    expect(statusLabel(status({ phase: "failed", lastError: "offline" }))).toBe(
      "Status: Failed — offline",
    );
  });

  // The private VM's install, image and boot phases are gone; whatever is in
  // flight is a hosted Rome being reached.
  it("reads every in-flight phase as connecting", () => {
    expect(statusLabel(status({ phase: "starting_rome" }))).toBe("Status: Connecting…");
    expect(statusLabel(status({ phase: "waiting_for_health" }))).toBe("Status: Connecting…");
  });
});

describe("setupTray", () => {
  // A hosted Rome keeps running after the app quits, so there is no agent to
  // stop on the way out.
  it("offers Quit Rome, never Stop agent and quit", () => {
    const runtime = Object.assign(new EventEmitter(), {
      getStatus: () => status({ phase: "ready" }),
    }) as unknown as Runtime;
    setupTray({
      getMainWindow: () => null,
      ensureMainWindow: rs.fn(),
      openSettings: rs.fn(),
      runtime,
      floatingPill: null,
    });
    const labels = menus.at(-1)?.map((item) => item.label);
    expect(labels).toContain("Quit Rome");
    expect(labels).toContain("Status: Ready");
    expect(labels?.some((label) => label?.startsWith("Computer Use:"))).toBe(false);
    expect(labels?.some((label) => /agent|Stopping/.test(label ?? ""))).toBe(false);
  });

  it("updates Computer Use while the device is off and shows the setting only in its submenu", () => {
    const runtime = Object.assign(new EventEmitter(), {
      getStatus: () => status({ phase: "ready" }),
    }) as unknown as Runtime;
    const open = rs.fn(async () => undefined);
    let enabled = false;
    let currentDevice: DeviceStatus = { state: "off" };
    let notifyChange: () => void = () => {};
    setupTray({
      getMainWindow: () => null,
      ensureMainWindow: rs.fn(),
      openSettings: rs.fn(),
      runtime,
      floatingPill: null,
      device: {
        status: () => currentDevice,
        onChange: (listener) => {
          notifyChange = listener;
        },
      },
      computerUseSettings: {
        status: () => ({ enabled, helperPresent: true }),
        open,
        revealHelper: rs.fn(),
      },
    });
    const item = menus.at(-1)?.find(({ label }) => label === "Computer Use: Off");
    const submenu = item?.submenu as Electron.MenuItemConstructorOptions[];
    expect(menus.at(-1)?.some(({ label }) => label?.startsWith("This Mac:"))).toBe(false);
    expect(submenu[0]).toMatchObject({ label: "Bundled helper: Installed", enabled: false });
    submenu
      .find(({ label }) => label === "Screen Recording Settings…")
      ?.click?.({} as never, undefined, {} as never);
    expect(open).toHaveBeenCalledWith("screenRecording");

    enabled = true;
    notifyChange();
    expect(menus.at(-1)?.map(({ label }) => label)).toContain("Computer Use: On");

    enabled = false;
    currentDevice = {
      state: "disabled",
      deviceId: "d1",
      name: "Mac",
      connection: "connected",
      computerUse: false,
    };
    notifyChange();
    expect(
      menus
        .at(-1)
        ?.filter(({ label }) => label?.startsWith("This Mac:"))
        .map(({ label }) => label),
    ).toEqual(["This Mac: Connected"]);
    expect(menus.at(-1)?.map(({ label }) => label)).toContain("Computer Use: Off");
  });
});

describe("deviceLabel", () => {
  const device = (partial: Partial<Extract<DeviceStatus, { deviceId: string }>>): DeviceStatus => ({
    state: "connected",
    deviceId: "d1",
    name: "Mac",
    connection: "connected",
    computerUse: true,
    ...partial,
  });

  it("says nothing while signed out", () => {
    expect(deviceLabel({ state: "off" })).toBeNull();
  });

  it("names the connection and, when it is off, Computer use", () => {
    expect(deviceLabel(device({}))).toBe("This Mac: Connected");
    expect(deviceLabel(device({ computerUse: false, state: "disabled" }))).toBe(
      "This Mac: Connected · Computer use off",
    );
    expect(deviceLabel(device({ connection: "connecting", state: "connecting" }))).toBe(
      "This Mac: Connecting…",
    );
    expect(
      deviceLabel(device({ connection: "offline", computerUse: false, state: "disabled" })),
    ).toBe("This Mac: Offline · Computer use off");
  });
});

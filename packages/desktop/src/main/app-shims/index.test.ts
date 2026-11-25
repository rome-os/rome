import { EventEmitter } from "events";
import { afterAll, describe, expect, it, rs } from "@rstest/core";

const electron = rs.hoisted(() => {
  const appEvents = new Map<string, (...args: unknown[]) => void>();
  const windows: Array<{ options: Record<string, unknown>; url?: string }> = [];
  return { appEvents, windows };
});

rs.mock("electron", () => {
  class FakeWindow {
    private handlers = new Map<string, () => void>();
    webContents = { setWindowOpenHandler: () => undefined };
    constructor(options: Record<string, unknown>) {
      electron.windows.push({ options });
    }
    once(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }
    loadURL(url: string) {
      electron.windows[electron.windows.length - 1].url = url;
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
  }
  return {
    app: {
      isPackaged: true,
      startAppShimServer: rs.fn(),
      on: (event: string, handler: (...args: unknown[]) => void) =>
        electron.appEvents.set(event, handler),
      getPath: () => "/Users/me/Desktop",
    },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (template: unknown) => template },
    dialog: { showMessageBox: rs.fn() },
    nativeImage: {},
    net: {},
    shell: {},
  };
});
rs.mock("../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import { setupAppShims } from "./index";
import { APP_SHIMS_KEY, type AppShimRecord } from "./store";

const CDHASH = "0123456789abcdef0123456789abcdef01234567";
const record: AppShimRecord = {
  installId: "0123456789ab",
  appId: "recipes",
  url: "https://ray.romeos.cc/full/apps/recipes",
  name: "Recipes",
  bundlePath: "/Users/me/Desktop/Recipes.app",
  cdhash: CDHASH,
};

function shim(bundleId: string, satisfies: (requirement: string) => boolean) {
  return Object.assign(new EventEmitter(), {
    bundleId,
    pid: 42,
    quit: rs.fn(),
    isConnected: () => true,
    setApplicationMenu: rs.fn(),
    satisfiesCodeRequirement: rs.fn(satisfies),
  });
}

describe("a shim connecting", () => {
  // The test runs off macOS too; the server only starts on macOS.
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  afterAll(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });
  const values = new Map([[APP_SHIMS_KEY, JSON.stringify([record])]]);
  setupAppShims({ read: (k) => values.get(k) ?? null, write: (k, v) => void values.set(k, v) });
  const connect = (s: ReturnType<typeof shim>) =>
    electron.appEvents.get("app-shim-connected")?.({}, s);
  // Read from the bundle when it can be, else the packaged app's id.
  const bundleId = "com.rome.desktop.app.0123456789ab";

  it("opens the app's page in a window of the shim when it is the bundle Rome made", () => {
    const s = shim(bundleId, (requirement) => requirement === `cdhash H"${CDHASH}"`);
    connect(s);
    expect(s.quit).not.toHaveBeenCalled();
    expect(s.setApplicationMenu).toHaveBeenCalled();
    const window = electron.windows.at(-1)!;
    expect(window.options.appShim).toBe(s);
    expect(window.options.webPreferences).not.toHaveProperty("preload");
    expect(window.url).toBe(record.url);
  });

  it("refuses a process that only claims the bundle id", () => {
    const before = electron.windows.length;
    const s = shim(bundleId, () => false);
    connect(s);
    expect(s.quit).toHaveBeenCalled();
    expect(electron.windows.length).toBe(before);
  });

  it("refuses a shim Rome never made", () => {
    const before = electron.windows.length;
    const s = shim("com.rome.desktop.app.ffffffffffff", () => true);
    connect(s);
    expect(s.quit).toHaveBeenCalled();
    expect(s.satisfiesCodeRequirement).not.toHaveBeenCalled();
    expect(electron.windows.length).toBe(before);
  });
});

import { describe, expect, it, rs } from "@rstest/core";

const store = rs.hoisted(() => new Map<string, string>());

rs.mock("electron", () => ({
  ipcMain: { handle: rs.fn() },
  BrowserWindow: class {},
  dialog: {},
  app: { getVersion: () => "0.0.0", isPackaged: false },
  shell: {},
}));
rs.mock("drizzle-orm", () => ({ eq: (_column: unknown, value: unknown) => value }));
rs.mock("./db/schema", () => ({ settings: { key: "key" } }));
rs.mock("./db/database", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (key: string) => ({
          get: () => (store.has(key) ? { value: store.get(key) } : undefined),
        }),
      }),
    }),
    insert: () => ({
      values: ({ key, value }: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({
          run: () => {
            store.set(key, value);
          },
        }),
      }),
    }),
  }),
}));
rs.mock("./pick-folder", () => ({ pickFolder: rs.fn() }));

import { ipcMain } from "electron";
import type { DeviceStatus } from "./cloud/device-host";
import {
  readDeviceEnabled,
  readNotificationsEnabled,
  registerIpcHandlers,
} from "./ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const ORIGIN = "https://ray.romeos.cc";
const status: DeviceStatus = {
  state: "disabled",
  deviceId: "d1",
  name: "Mac",
  connection: "connected",
  computerUse: false,
};

function register() {
  const device = {
    status: () => status,
    start: rs.fn(async () => undefined),
    stop: rs.fn(async () => undefined),
    setEnabled: rs.fn(async () => undefined),
  };
  registerIpcHandlers(
    {
      runtime: {},
      activeTarget: () => ({ kind: "remote", instance: { id: "i", name: "n", origin: ORIGIN } }),
    } as never,
    {
      openSettingsWindow: rs.fn(),
      openAuditWindow: rs.fn(),
      cloudAccount: {} as never,
      device,
    },
  );
  const handlers = new Map<string, Handler>();
  for (const [channel, handler] of (
    ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }
  ).mock.calls)
    handlers.set(channel, handler);
  return { device, handlers };
}

const from = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } });

describe("notifications setting", () => {
  it("is on until the user turns it off", () => {
    store.clear();
    expect(readNotificationsEnabled()).toBe(true);
    store.set("notifications.enabled", "false");
    expect(readNotificationsEnabled()).toBe(false);
    store.set("notifications.enabled", "true");
    expect(readNotificationsEnabled()).toBe(true);
  });

  it("is a separate setting from Computer use", () => {
    store.clear();
    store.set("notifications.enabled", "false");
    expect(readDeviceEnabled()).toBe(true);
  });
});

describe("who can change the notifications setting", () => {
  const { device, handlers } = register();
  const set = handlers.get("settings:set")!;
  const get = handlers.get("settings:get")!;

  it("is the app's own pages, through settings:get and settings:set", async () => {
    store.clear();
    const own = from("file:///Rome.app/settings.html");
    await set(own, "notifications.enabled", "false");
    expect(store.get("notifications.enabled")).toBe("false");
    expect(readNotificationsEnabled()).toBe(false);
    expect(await get(own, "notifications.enabled")).toBe("false");
  });

  it("is never the Rome's dashboard, or any other page", () => {
    store.clear();
    for (const event of [
      from(`${ORIGIN}/settings`),
      from(`${ORIGIN}/app`, {}),
      from("https://evil.example/"),
      { senderFrame: null },
    ]) {
      expect(() => set(event, "notifications.enabled", "false")).toThrow(
        "settings:set is not available to this page",
      );
      expect(() => get(event, "notifications.enabled")).toThrow(
        "settings:get is not available to this page",
      );
    }
    expect(store.has("notifications.enabled")).toBe(false);
  });

  it("has no device channel for it, so the dashboard's device bridge cannot reach it", () => {
    expect(handlers.has("device:setNotificationsEnabled")).toBe(false);
    expect(device.setEnabled).not.toHaveBeenCalled();
  });
});

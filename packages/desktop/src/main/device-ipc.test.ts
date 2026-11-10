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
  writeNotificationsEnabled,
} from "./ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const ORIGIN = "https://ray.romeos.cc";
const status: DeviceStatus = {
  state: "disabled",
  deviceId: "d1",
  name: "Mac",
  connection: "connected",
  computerUse: false,
  notifications: false,
};

function register() {
  const device = {
    status: () => status,
    start: rs.fn(async () => undefined),
    stop: rs.fn(async () => undefined),
    setEnabled: rs.fn(async () => undefined),
    setNotificationsEnabled: rs.fn(),
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
    writeNotificationsEnabled(false);
    expect(readNotificationsEnabled()).toBe(false);
    writeNotificationsEnabled(true);
    expect(readNotificationsEnabled()).toBe(true);
  });

  it("is a separate setting from Computer use", () => {
    store.clear();
    writeNotificationsEnabled(false);
    expect(readDeviceEnabled()).toBe(true);
    expect(store.get("notifications.enabled")).toBe("false");
    expect(store.has("device.enabled")).toBe(false);
  });
});

describe("device:setNotificationsEnabled", () => {
  const { device, handlers } = register();
  const handler = handlers.get("device:setNotificationsEnabled")!;

  it("changes the choice and answers with the new status", async () => {
    expect(await handler(from("file:///Rome.app/settings.html"), false)).toBe(status);
    expect(device.setNotificationsEnabled).toHaveBeenCalledWith(false);
    expect(await handler(from(`${ORIGIN}/settings`), true)).toBe(status);
    expect(device.setNotificationsEnabled).toHaveBeenLastCalledWith(true);
  });

  it("is refused to other origins and to frames inside the Rome", () => {
    device.setNotificationsEnabled.mockClear();
    for (const event of [
      from("https://evil.example/"),
      from(`${ORIGIN}/app`, {}),
      { senderFrame: null },
    ])
      expect(() => handler(event, false)).toThrow("not available to this page");
    expect(device.setNotificationsEnabled).not.toHaveBeenCalled();
  });

  it("takes only a boolean", () => {
    for (const value of ["false", 0, null, undefined])
      expect(() => handler(from(`${ORIGIN}/`), value)).toThrow();
    expect(device.setNotificationsEnabled).not.toHaveBeenCalledWith("false");
  });

  it("is trusted the same way as device:setEnabled", () => {
    for (const event of [from("https://evil.example/"), from(`${ORIGIN}/app`, {})])
      expect(() => handlers.get("device:setEnabled")!(event, false)).toThrow(
        "not available to this page",
      );
  });
});

import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({
  ipcMain: { handle: rs.fn() },
  app: { getVersion: () => "0.0.0", getPath: () => "/tmp" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: rs.fn(async () => ({ canceled: true })) },
  shell: { showItemInFolder: rs.fn() },
}));

rs.mock("@rome-os/node-core/host", () => ({ AuditStore: { open: rs.fn() } }));

import { ipcMain } from "electron";
import type { AuditStore } from "@rome-os/node-core/host";
import { registerAuditHandlers } from "./audit";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const registered = new Map<string, Handler>();

const store = {
  path: "/Users/me/.rome-desktop/audit/audit.db",
  status: async () => ({ state: "ok" }),
  summary: () => ({ records: 1 }),
  list: rs.fn(() => []),
  get: () => null,
  content: () => null,
  verify: async () => ({ ok: true, records: 1 }),
  export: rs.fn(async () => undefined),
} as unknown as AuditStore;

const sender = (url: string) => ({ senderFrame: { url }, sender: {} });

describe("audit IPC", () => {
  registerAuditHandlers(store);
  for (const [channel, handler] of (
    ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }
  ).mock.calls)
    registered.set(channel, handler);
  const channels = [
    "audit:status",
    "audit:list",
    "audit:get",
    "audit:counts",
    "audit:stats",
    "audit:content",
    "audit:saveContent",
    "audit:verify",
    "audit:export",
    "audit:reveal",
  ];

  it("answers only the app's own file: pages", async () => {
    expect([...registered.keys()].sort()).toEqual([...channels].sort());
    for (const channel of channels)
      for (const url of ["https://ray.romeos.cc/settings/devices", "http://127.0.0.1:4141/", ""])
        expect(() => registered.get(channel)!(sender(url), 1, "stdout")).toThrow(
          `${channel} is not available to this page`,
        );
    expect(await registered.get("audit:status")!(sender("file:///Rome.app/audit.html"))).toEqual({
      records: 1,
    });
  });

  it("validates what a page asks for", async () => {
    const file = sender("file:///Rome.app/audit.html");
    registered.get("audit:list")!(file, { action: "exec", limit: 5 });
    expect(store.list).toHaveBeenCalledWith({ action: "exec", limit: 5 });
    expect(() => registered.get("audit:list")!(file, { sql: "DROP TABLE events" })).toThrow();
    expect(() => registered.get("audit:content")!(file, 1, "../../etc/passwd")).toThrow();
    expect(() => registered.get("audit:get")!(file, -1)).toThrow();
  });
});

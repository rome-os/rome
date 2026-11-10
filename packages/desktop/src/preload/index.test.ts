import { afterEach, describe, expect, it, rs } from "@rstest/core";

const exposed = rs.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
rs.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed.value = api;
    },
  },
  ipcRenderer: { invoke: rs.fn(), on: rs.fn(), removeListener: rs.fn(), send: rs.fn() },
}));

async function load(protocol: string) {
  rs.resetModules();
  Object.assign(globalThis, {
    location: { protocol },
    document: { readyState: "complete", documentElement: { classList: { add: () => {} } } },
  });
  await import("./index");
  return exposed.value!;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "document");
});

describe("preload bridge", () => {
  it("gives remote pages only the device bridge, never the audit log", async () => {
    const remote = await load("https:");
    expect(Object.keys(remote)).toEqual(["device"]);
    expect(remote.audit).toBeUndefined();
    // Settings, such as the notifications choice, belong to the app's own pages.
    expect(remote.settings).toBeUndefined();
    // The device bridge can open the local audit window, but carries nothing from the log.
    expect(Object.keys(remote.device as object).sort()).toEqual(
      ["get", "onStatus", "openAuditLog", "pickFolder", "setEnabled"].sort(),
    );
  });

  it("gives the app's own pages the audit log", async () => {
    const local = await load("file:");
    expect(Object.keys(local.audit as object).sort()).toEqual(
      ["content", "counts", "get", "list", "reveal", "stats", "status"].sort(),
    );
  });
});

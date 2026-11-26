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

const realPlatform = process.platform;

async function load(protocol: string, platform: NodeJS.Platform = "linux") {
  rs.resetModules();
  Object.defineProperty(process, "platform", { value: platform });
  Object.assign(globalThis, {
    location: { protocol },
    document: { readyState: "complete", documentElement: { classList: { add: () => {} } } },
  });
  await import("./index");
  return exposed.value!;
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "document");
});

describe("preload bridge", () => {
  it("gives remote pages only the device bridge and the microphone marker, never the audit log", async () => {
    const remote = await load("https:");
    expect(Object.keys(remote)).toEqual(["device", "microphone"]);
    expect(remote.microphone).toBe(true);
    expect(remote.audit).toBeUndefined();
    // Settings, such as the notifications choice, belong to the app's own pages.
    expect(remote.settings).toBeUndefined();
    // The device bridge can open the local audit window, but carries nothing from the log.
    expect(Object.keys(remote.device as object).sort()).toEqual(
      ["get", "onStatus", "openAuditLog", "pickFolder", "setEnabled"].sort(),
    );
  });

  it("adds the Desktop apps bridge on macOS, which carries only adding an app", async () => {
    const remote = await load("https:", "darwin");
    expect(Object.keys(remote)).toEqual(["device", "microphone", "apps"]);
    expect(Object.keys(remote.apps as object)).toEqual(["addToDesktop"]);
  });

  it("gives the app's macOS pages the Computer Use settings bridge", async () => {
    const local = await load("file:", "darwin");
    expect(Object.keys(local.computerUse as object)).toEqual([
      "status",
      "openSettings",
      "revealHelper",
    ]);
    expect((await load("file:")).computerUse).toBeUndefined();
  });

  it("gives the app's own pages the audit log", async () => {
    const local = await load("file:");
    expect(Object.keys(local.audit as object).sort()).toEqual(
      ["content", "counts", "get", "list", "reveal", "stats", "status"].sort(),
    );
  });
});

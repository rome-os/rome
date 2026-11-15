import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { deviceKinds, deviceKindState } from "../connections/connect-card.js";
import { createLiveRoutes } from "../connections/device/live-route.js";
import { DeviceConnectionsRepository } from "../connections/device/repository.js";
import { createTestDb } from "../test/db.js";
import { connectAccountTools } from "./connect-account-tool.js";

describe("connect_account", () => {
  // Where Rome Cloud is set up, as on a provisioned instance.
  beforeEach(() => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
  });
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  const call = async (widgets: "card" | "plain_text", args: unknown, hasSpeaker = true) => {
    const [tool] = connectAccountTools({ widgets, hasSpeaker });
    return { tool, result: await tool!.handler(args as Record<string, unknown>) };
  };

  it("ends the turn on the connect card where cards show", async () => {
    const { tool, result } = await call("card", { kind: "github" });
    expect(tool?.endsTurn).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      pendingInteraction: true,
      render: { componentId: "connect-card", props: { kind: "github" }, builtin: true },
    });
  });

  it("asks for Settings in a message, and goes on, where no card shows", async () => {
    const { tool, result } = await call("plain_text", { kind: "slack" });
    expect(tool?.endsTurn).toBe(false);
    expect(result.content[0]!.text).toContain("Settings › Connections");
  });

  it("refuses a kind Rome does not connect itself", async () => {
    const { result } = await call("card", { kind: "notion" });
    expect(result.isError).toBe(true);
  });

  it("offers the device kinds devices reported, and shows their card", async () => {
    const [tool] = connectAccountTools({
      widgets: "card",
      hasSpeaker: true,
      devices: [{ kind: "apple_health", label: "Apple Health" }],
    });
    const kinds = (tool!.inputSchema as { properties: { kind: { enum: string[] } } }).properties
      .kind.enum;
    expect(kinds).toContain("apple_health");
    expect(kinds).toContain("github");
    const result = await tool!.handler({ kind: "apple_health" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      render: { props: { kind: "apple_health", label: "Apple Health", device: true } },
    });
  });

  it("answers that a device kind already works, read when called, with no card", async () => {
    let state: "working" | "off" = "off";
    const [tool] = connectAccountTools({
      widgets: "card",
      hasSpeaker: true,
      devicesOnly: true,
      devices: [{ kind: "apple_health", label: "Apple Health" }],
      deviceState: () => ({ state, device: "iPhone" }),
    });
    // The description holds no state, so the session's tools stay the same.
    expect(tool!.description).not.toContain("working");
    const off = await tool!.handler({ kind: "apple_health" });
    expect(JSON.parse(off.content[0]!.text)).toMatchObject({ pendingInteraction: true });
    state = "working";
    const working = await tool!.handler({ kind: "apple_health" });
    expect(working.content[0]!.text).toBe(
      "Apple Health is already connected on iPhone. Go ahead; no card shown.",
    );
  });

  it("shows the asking device's card when another install reports the kind working", async () => {
    const testDb = createTestDb();
    try {
      const devices = new DeviceConnectionsRepository(testDb.db);
      const health = (id: string, live: boolean) =>
        devices.report(
          {
            version: 1,
            device: { id, name: id, platform: "ios" },
            connections: [
              {
                capability: "apple_health",
                title: "Apple Health",
                prefix: "health",
                personal: true,
                operations: [{ name: "health.stats", access: "read" }],
                permission: "unknown",
                live,
                feeds: "apple_health",
              },
            ],
          },
          Date.now(),
        );
      health("dev-asking", false);
      health("dev-other", true);
      const routes = createLiveRoutes(devices);
      const toolFor = (askingDeviceId?: string) =>
        connectAccountTools({
          widgets: "card",
          hasSpeaker: true,
          devicesOnly: true,
          devices: deviceKinds(devices.list()),
          deviceState: (kind) =>
            deviceKindState(routes.forKind(kind, { askingDeviceId }), { askingDeviceId }),
        })[0]!;
      const asked = await toolFor("dev-asking").handler({ kind: "apple_health" });
      expect(JSON.parse(asked.content[0]!.text)).toMatchObject({
        pendingInteraction: true,
        render: { props: { kind: "apple_health", device: true, deviceId: "dev-asking" } },
      });
      // A turn no device started takes the working install, as before.
      const web = await toolFor(undefined).handler({ kind: "apple_health" });
      expect(web.content[0]!.text).toBe(
        "Apple Health is already connected on dev-other. Go ahead; no card shown.",
      );
    } finally {
      testDb.close();
    }
  });
});

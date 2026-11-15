import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
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

  it("says how each device kind stands, so the agent reads it instead of asking", () => {
    const [tool] = connectAccountTools({
      widgets: "card",
      hasSpeaker: true,
      devicesOnly: true,
      devices: [
        { kind: "device", label: "Device", state: "off", device: "iPhone" },
        { kind: "apple_health", label: "Apple Health", state: "working", device: "iPhone" },
      ],
    });
    expect(tool!.description).toContain("`device` (Device on iPhone): off");
    expect(tool!.description).toContain("`apple_health` (Apple Health on iPhone): working");
    expect(tool!.description).toContain("Never ask whether a device is connected");
  });
});

import { describe, expect, it } from "@rstest/core";
import { connectAccountTools } from "./connect-account-tool.js";

describe("connect_account", () => {
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
});

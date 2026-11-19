import { describe, expect, it } from "@rstest/core";
import {
  CONNECTION_INSTRUCTION,
  chatInstructionsOf,
  conciergeOnConnection,
  onConnection,
} from "./on-connection.js";

describe("the Concierge on a connection", () => {
  it("tells a chat on a connection from a dashboard chat, and an unknown place from both", () => {
    expect(onConnection({ channel: "telegram" })).toBe(true);
    expect(onConnection({ channel: "webchat" })).toBe(false);
    expect(onConnection(undefined)).toBe(false);
  });

  it("adds its instruction only to the Concierge, and only on a connection", async () => {
    expect(await conciergeOnConnection({ channel: "slack" }, "core:concierge")).toBe(
      CONNECTION_INSTRUCTION,
    );
    expect(await conciergeOnConnection({ channel: "webchat" }, "core:concierge")).toBeNull();
    expect(await conciergeOnConnection({ channel: "slack" }, "core:main")).toBeNull();
    expect(await conciergeOnConnection(undefined, "core:concierge")).toBeNull();
  });

  it("joins every chat instruction that adds one, and answers null when none does", async () => {
    const combined = chatInstructionsOf([
      async () => "first",
      async () => null,
      async (_thread, agent) => `for ${agent}`,
    ]);
    expect(await combined(undefined, "core:concierge")).toBe("first\n\nfor core:concierge");
    expect(await chatInstructionsOf([async () => null])(undefined, "core:main")).toBeNull();
  });
});

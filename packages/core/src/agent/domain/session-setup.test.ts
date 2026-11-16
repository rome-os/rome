import { describe, expect, it } from "@rstest/core";
import { NO_ROME_TOOLS, ROME_TOOL_GROUPS } from "./rome-tools.js";
import { type SessionSetup, setupChange, setupFingerprint } from "./session-setup.js";

const setup: SessionSetup = {
  systemPrompt: "You are the Concierge.",
  builtinTools: ["WebSearch"],
  mcpServers: [],
  outputSchema: null,
  tools: Object.fromEntries(
    ROME_TOOL_GROUPS.map((group) => [group, NO_ROME_TOOLS.listTools(group)]),
  ) as SessionSetup["tools"],
};

describe("setupChange", () => {
  const before = setupFingerprint(setup);

  it("tells nothing, the text, or the tools apart", () => {
    expect(setupChange(before, setupFingerprint({ ...setup }))).toBe("none");
    expect(setupChange(before, setupFingerprint({ ...setup, systemPrompt: "Be brief." }))).toBe(
      "text",
    );
    expect(setupChange(before, setupFingerprint({ ...setup, builtinTools: [] }))).toBe("tools");
  });

  it("calls a change of both a tool change", () => {
    const both = setupFingerprint({ ...setup, systemPrompt: "Be brief.", builtinTools: [] });
    expect(setupChange(before, both)).toBe("tools");
  });

  it("cannot tell what changed since a setup of one part, or none", () => {
    expect(setupChange("a".repeat(64), before)).toBe("unknown");
    expect(setupChange(null, before)).toBe("unknown");
  });
});

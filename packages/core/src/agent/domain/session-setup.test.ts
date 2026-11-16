import { describe, expect, it } from "@rstest/core";
import { NO_ROME_TOOLS, ROME_TOOL_GROUPS } from "./rome-tools.js";
import { type SessionSetup, setupChange, setupChanged, setupFingerprint } from "./session-setup.js";

const setup: SessionSetup = {
  systemPrompt: "You are the Concierge.",
  identity: "**Agent Name:** Yo",
  builtinTools: ["WebSearch"],
  mcpServers: [],
  outputSchema: null,
  tools: Object.fromEntries(
    ROME_TOOL_GROUPS.map((group) => [group, NO_ROME_TOOLS.listTools(group)]),
  ) as SessionSetup["tools"],
};

describe("setupChange", () => {
  const before = setupFingerprint(setup);
  const changeTo = (next: Partial<SessionSetup>) =>
    setupChange(before, setupFingerprint({ ...setup, ...next }));

  it("tells which parts changed", () => {
    expect(changeTo({})).toEqual({ text: false, tools: false, identity: false });
    expect(changeTo({ systemPrompt: "Be brief." })).toEqual({
      text: true,
      tools: false,
      identity: false,
    });
    expect(changeTo({ builtinTools: [] })).toEqual({ text: false, tools: true, identity: false });
    expect(changeTo({ identity: "**Agent Name:** YoYo" })).toEqual({
      text: false,
      tools: false,
      identity: true,
    });
    expect(changeTo({ systemPrompt: "Be brief.", builtinTools: [] })).toEqual({
      text: true,
      tools: true,
      identity: false,
    });
  });

  it("cannot tell what changed since a setup without parts, or none", () => {
    expect(setupChange("a".repeat(64), before)).toBe("unknown");
    expect(setupChange(null, before)).toBe("unknown");
    expect(setupChanged(setupChange(null, before))).toBe(true);
    expect(setupChanged(changeTo({}))).toBe(false);
  });
});

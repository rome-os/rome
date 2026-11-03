import { describe, expect, it, rs } from "@rstest/core";
import { buildFacadeBundle, type FacadeParams } from "./mcp-facade.js";
import { createRomeMcpServerForSession } from "./mcp/server.js";

function baseParams(overrides: Partial<FacadeParams> = {}): FacadeParams {
  return {
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => ({}),
    executeSubagent: async () => ({}),
    ...overrides,
  };
}

const deferTool = (params: FacadeParams) =>
  buildFacadeBundle(params).interactiveTools.find((t) => t.name === "defer");

describe("defer facade tool", () => {
  it("is absent when no executeDefer is wired", () => {
    expect(deferTool(baseParams())).toBeUndefined();
  });

  it("registers on a non-interactive surface (no UI needed — it injects a message)", () => {
    const executeDefer = rs.fn().mockResolvedValue({ ok: true });
    const tool = deferTool(baseParams({ executeDefer, supportsInteractiveSurface: false }));
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({ required: ["name"] });
  });

  it("relays the call to executeDefer and returns its result", async () => {
    const executeDefer = rs
      .fn()
      .mockResolvedValue({ ok: true, deferredUntil: "2026-06-25T12:05:00.000Z" });
    const tool = deferTool(baseParams({ executeDefer, supportsInteractiveSurface: true }));
    const result = await tool!.handler({ name: "check CI", afterMinutes: 5 });
    expect(executeDefer).toHaveBeenCalledWith({ name: "check CI", afterMinutes: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("2026-06-25T12:05:00.000Z");
  });

  // A private-text agent can confirm only with another message, which repeats
  // what it already told the guardian.
  it.each([
    [false, true],
    [true, false],
  ])("with textPrivate %s, asks for a confirmation line: %s", (textPrivate, confirms) => {
    const executeDefer = rs.fn().mockResolvedValue({ ok: true });
    const description = deferTool(baseParams({ executeDefer, textPrivate }))!.description;
    expect(description.includes("write one short line confirming")).toBe(confirms);
    expect(description).toContain("end your turn");
  });

  it("carries textPrivate from the session params into the Codex tool server", () => {
    const server = createRomeMcpServerForSession({
      ...baseParams(),
      model: "gpt-test",
      systemPrompt: "system",
      executeDefer: rs.fn().mockResolvedValue({ ok: true }),
      textPrivate: true,
    });
    const defer = server.listTools("ask_user").find((tool) => tool.name === "defer");
    expect(defer?.description).not.toContain("write one short line confirming");
  });

  it("surfaces a thrown error as a tool error", async () => {
    const executeDefer = rs.fn().mockRejectedValue(new Error("defer fires in the past"));
    const tool = deferTool(baseParams({ executeDefer, supportsInteractiveSurface: true }));
    const result = await tool!.handler({ name: "x", at: "2020-01-01T00:00:00Z" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("defer fires in the past");
  });
});

describe("session tools", () => {
  it("register beside defer on every surface, and none by default", async () => {
    const handler = rs.fn().mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
    const say = { name: "say", description: "Speak", inputSchema: { type: "object" }, handler };
    const names = (params: FacadeParams) =>
      buildFacadeBundle(params).interactiveTools.map((tool) => tool.name);
    expect(names(baseParams())).not.toContain("say");
    expect(names(baseParams({ sessionTools: [say], supportsInteractiveSurface: false }))).toContain(
      "say",
    );
    const tool = buildFacadeBundle(baseParams({ sessionTools: [say] })).interactiveTools.find(
      (candidate) => candidate.name === "say",
    );
    await tool?.handler({ text: "hi" });
    expect(handler).toHaveBeenCalledWith({ text: "hi" });
  });
});

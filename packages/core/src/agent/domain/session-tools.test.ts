import { describe, expect, it } from "@rstest/core";
import type { RomeTool, RomeToolDefinition } from "./rome-tools.js";
import { forkSessionTools } from "./session-tools.js";

const definition = (name: string, extra: Partial<RomeToolDefinition> = {}): RomeToolDefinition => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  ...extra,
});

const own = (name: string, text: string): RomeTool => ({
  ...definition(name, { description: "the fork's own description" }),
  handler: async () => ({ content: [{ type: "text", text }] }),
});

describe("forkSessionTools", () => {
  it("serves the source's tools in the source's order, as the model saw them there", () => {
    const source = [definition("say"), definition("propose_routine", { endsTurn: true })];
    const tools = forkSessionTools(source, [own("propose_routine", "fork")]);

    expect(tools.map(({ handler: _handler, ...rest }) => rest)).toEqual(source);
  });

  it("runs a tool through the fork's own tool of the same name", async () => {
    const [tool] = forkSessionTools(
      [definition("propose_routine")],
      [own("propose_routine", "fork")],
    );

    expect(await tool.handler({})).toEqual({ content: [{ type: "text", text: "fork" }] });
  });

  it("refuses a tool the fork has none for as unavailable in a forked turn", async () => {
    const [tool] = forkSessionTools([definition("say")], []);

    expect(await tool.handler({})).toEqual({
      content: [{ type: "text", text: "say is unavailable in a forked turn." }],
      isError: true,
    });
  });

  it("does not serve a tool of the fork's own that the source did not have", () => {
    const tools = forkSessionTools([definition("say")], [own("propose_routine", "fork")]);

    expect(tools.map((tool) => tool.name)).toEqual(["say"]);
  });
});

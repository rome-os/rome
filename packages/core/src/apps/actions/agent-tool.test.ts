import { describe, expect, it, rs } from "@rstest/core";
import { z } from "zod";
import { approvalOf, callTool, whoMayAskSuite } from "./agent-tool-contract.js";
import { agentToolsOf, toolError } from "./agent-tool.js";

interface Deps {
  names: Map<string, string>;
}

const agentTool = agentToolsOf<Deps>();

const renameThing = agentTool({
  name: "system:rename_thing",
  description: "Rename a thing",
  sideEffects: "write",
  input: z.object({
    thingId: z.string().describe("The thing's id."),
    name: z.string().min(1).describe("Its new name."),
  }),
  approval: ({ thingId, name }, { deps }) => ({
    title: `Rename ${deps.names.get(thingId) ?? thingId}`,
    summary: `It is called ${name} from now on.`,
  }),
  run: async ({ thingId, name }, { deps }) => {
    if (!deps.names.has(thingId)) return toolError(`No thing "${thingId}".`);
    deps.names.set(thingId, name);
    return { thingId, name };
  },
});

const showThing = agentTool({
  name: "system:show_thing",
  description: "Show a thing",
  sideEffects: "read-only",
  input: z.object({ thingId: z.string() }),
  run: async ({ thingId }) => ({ thingId }),
});

const deps = (): Deps => ({ names: new Map([["t-1", "Old"]]) });

whoMayAskSuite(renameThing, { thingId: "t-1", name: "New" });
whoMayAskSuite(showThing, { thingId: "t-1" });

describe("an agent tool's action", () => {
  it("carries the declaration's name, description and side effects", () => {
    const action = renameThing.action(deps(), async () => null);

    expect(action.config).toMatchObject({
      name: "system:rename_thing",
      description: "Rename a thing",
      sideEffects: "write",
      requiresApproval: true,
    });
    expect(action.inputSchema).toMatchObject({
      properties: { thingId: { description: "The thing's id." } },
      required: ["thingId", "name"],
    });
  });

  it("asks for no approval when the tool declares none", () => {
    expect(showThing.action(deps(), async () => null).config.requiresApproval).toBeUndefined();
  });

  it("returns what run returns as the agent's data", async () => {
    const d = deps();

    expect(await callTool(renameThing, d, { thingId: "t-1", name: "New" })).toEqual({
      status: "ok",
      data: { thingId: "t-1", name: "New" },
    });
    expect(d.names.get("t-1")).toBe("New");
  });

  it("returns a tool error as an error the agent reads", async () => {
    expect(await callTool(renameThing, deps(), { thingId: "t-9", name: "New" })).toEqual({
      status: "error",
      error: 'No thing "t-9".',
    });
  });

  it("answers an input that does not fit with what is wrong, and does not run", async () => {
    const d = deps();

    const result = await callTool(renameThing, d, { thingId: "t-1", name: "" });

    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("name") });
    expect(d.names.get("t-1")).toBe("Old");
  });

  it("words the approval card from the input and the deps", async () => {
    expect(await approvalOf(renameThing, deps(), { thingId: "t-1", name: "New" })).toEqual({
      kind: "generic",
      title: "Rename Old",
      summary: "It is called New from now on.",
    });
  });

  it("checks who asks once per call, before run", async () => {
    const check = rs.fn(async () => "needs_guardian: no");
    const d = deps();

    const result = await renameThing.action(d, check).execute({ thingId: "t-1", name: "New" });

    expect(result).toEqual({ status: "error", error: "needs_guardian: no" });
    expect(check).toHaveBeenCalledTimes(1);
    expect(d.names.get("t-1")).toBe("Old");
  });
});

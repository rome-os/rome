import { describe, expect, it, rs } from "@rstest/core";
import { z } from "zod";
import { approvalOf, callTool, whoMayAskSuite } from "./agent-tool-contract.js";
import { agentToolsOf, toolError } from "./agent-tool.js";
import { decidesApprovalPerCall } from "./types.js";

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

  it("has the engine decide each call from its approval", () => {
    expect(decidesApprovalPerCall(renameThing.action(deps(), async () => null))).toBe(true);
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

  it("words no card for an input its approval returns nothing for", async () => {
    const renameUnlessSame = agentTool({
      name: "system:rename_thing",
      description: "Rename a thing",
      sideEffects: "write",
      input: z.object({ thingId: z.string(), name: z.string() }),
      approval: ({ thingId, name }, { deps }) =>
        deps.names.get(thingId) === name ? undefined : { title: "Rename", summary: name },
      run: async (input) => input,
    });

    expect(await approvalOf(renameUnlessSame, deps(), { thingId: "t-1", name: "Old" })).toBe(
      undefined,
    );
    expect(await approvalOf(renameUnlessSame, deps(), { thingId: "t-1", name: "New" })).toEqual({
      kind: "generic",
      title: "Rename",
      summary: "New",
    });
  });

  it("words no card for an input that does not fit, which execute answers with an error", async () => {
    expect(await approvalOf(renameThing, deps(), { thingId: "t-1" })).toBe(undefined);
  });

  it("passes on an approval that throws, so the engine does not run the call", async () => {
    const broken = agentTool({
      name: "system:rename_thing",
      description: "Rename a thing",
      sideEffects: "write",
      input: z.object({ thingId: z.string() }),
      approval: () => {
        throw new Error("no such thing");
      },
      run: async (input) => input,
    });

    await expect(approvalOf(broken, deps(), { thingId: "t-1" })).rejects.toThrow("no such thing");
  });

  it("refuses a turn that may not ask before its approval reads the deps", async () => {
    const visitorTurn = {
      audience: "private" as const,
      channelContext: { channel: "webchat", threadId: "visitor-chat" },
    };
    const touched = rs.fn();
    const watched = agentTool({
      name: "system:rename_thing",
      description: "Rename a thing",
      sideEffects: "write",
      input: z.object({ thingId: z.string() }),
      approval: () => {
        touched();
        return { title: "Rename", summary: "" };
      },
      run: async (input) => input,
    });

    await expect(approvalOf(watched, deps(), { thingId: "t-1" }, visitorTurn)).rejects.toThrow(
      /^needs_guardian: /,
    );
    expect(touched).not.toHaveBeenCalled();
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

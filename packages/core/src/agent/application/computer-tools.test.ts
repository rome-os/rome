import { describe, expect, it, rs } from "@rstest/core";
import { computerTools } from "./computer-tools.js";
import { permitsComputerUse } from "../domain/computer-use.js";
import type { TurnFacts } from "../domain/turn-facts.js";

const turn: TurnFacts = {
  agentName: "core:main",
  continuityKey: "chat",
  sessionId: "session",
  isSubagent: false,
  actions: ["*"],
  widgets: "plain_text",
  turnId: () => "turn",
  live: () => true,
  threadContext: () => undefined,
  sharedContext: () => undefined,
  pushLevel: () => undefined,
  actor: () => ({ kind: "guardian", userId: "guardian" }),
  audience: () => "private",
  reportedTask: () => undefined,
  inTurn: (fn) => fn(),
};

describe("computer tools", () => {
  it("are absent without a port or permission, and recheck an inherited catalog at call time", async () => {
    expect(computerTools(undefined, turn)).toEqual([]);
    let permitted = true;
    const run = rs.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const port = { permits: () => permitted, run };
    const tools = computerTools(port, turn);
    expect(tools.length).toBeGreaterThan(0);
    permitted = false;
    expect((await tools[0].handler({})).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(computerTools(port, { ...turn, actions: [] })).toEqual([]);
    expect(computerTools(port, { ...turn, isSubagent: true })).toEqual([]);
    expect(
      computerTools(port, { ...turn, isSubagent: true, actions: ["core:computer_use"] }),
    ).toEqual([]);
  });

  it("does not turn a phone device read permission into computer input permission", () => {
    expect(permitsComputerUse(turn)).toBe(true);
    expect(permitsComputerUse({ ...turn, actions: ["core:device_run"] })).toBe(false);
    expect(permitsComputerUse({ ...turn, actions: ["core:computer_use"] })).toBe(true);
    expect(permitsComputerUse({ ...turn, isSubagent: true, actions: [] })).toBe(false);
    expect(permitsComputerUse({ ...turn, isSubagent: true, actions: ["core:computer_use"] })).toBe(
      false,
    );
  });

  it("honors place-level withheldActions for wildcard and explicit computer-use grants", async () => {
    const run = rs.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const port = { permits: permitsComputerUse, run };

    for (const actions of [["*"], ["core:computer_use"]] as const) {
      for (const withheldActions of [["core:computer_use"], ["*"]] as const) {
        const denied = { ...turn, actions, withheldActions };
        expect(permitsComputerUse(denied)).toBe(false);
        expect(computerTools(port, denied)).toEqual([]);
      }
    }

    // Inherited catalogs recheck dynamic withheldActions at call time.
    let withheld: readonly string[] = [];
    const dynamicTurn: TurnFacts = {
      ...turn,
      get withheldActions() {
        return withheld;
      },
    };
    const tools = computerTools(port, dynamicTurn);
    expect(tools.length).toBeGreaterThan(0);
    withheld = ["core:computer_use"];
    expect((await tools[0].handler({})).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("avoids oneOf/anyOf in tool schemas for model provider compatibility", () => {
    const tools = computerTools({ permits: () => true, run: rs.fn() }, turn);
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(?:oneOf|anyOf)"/);
    }
  });

  it("registers the declared catalog before a live turn exists but refuses execution", async () => {
    const inactive = { ...turn, live: () => false, actor: () => undefined };
    const run = rs.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected" }] }));
    const tools = computerTools({ permits: permitsComputerUse, run }, inactive);
    expect(tools[0].name).toBe("computer_status");
    expect((await tools[0].handler({})).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});

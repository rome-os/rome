import type { ActionResult } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import {
  actionToolOutput,
  describeAction,
  searchActions,
  type AgentAction,
} from "./agent-action.js";

function action(overrides: Partial<AgentAction> & { name: string }): AgentAction {
  return {
    description: "does a thing",
    type: "read",
    complexity: "low",
    speed: "fast",
    reliability: "high",
    sideEffects: "none",
    requiresApproval: false,
    cancellable: false,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as AgentAction;
}

describe("describeAction", () => {
  it("tells the model how to pass each argument", () => {
    const described = describeAction(
      action({
        name: "fetch",
        inputSchema: {
          type: "object",
          required: ["limit"],
          properties: {
            limit: { type: "integer", description: "How many" },
            label: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      }),
    );

    expect(described.arguments).toEqual([
      {
        name: "limit",
        type: "integer",
        required: true,
        description: "How many",
        guidance:
          'Pass this value as a JSON integer, e.g. 10. Do not pass it as a string like "10".',
      },
      { name: "label", type: "string", required: false },
      { name: "tags", type: "array", required: false, items: { type: "string" } },
    ]);
    expect(described).not.toHaveProperty("inputSchema");
  });
});

describe("searchActions", () => {
  const catalog = [
    action({ name: "zeta_mail", description: "unrelated" }),
    action({ name: "alpha", description: "sends mail" }),
    action({ name: "beta", description: "other" }),
  ];
  const names = (query: string, limit?: number) =>
    searchActions(catalog, query, limit).map((found) => found.name);

  it("ranks a match in the name above one in the description", () => {
    expect(names("mail")).toEqual(["zeta_mail", "alpha"]);
  });

  it("lists by name for an empty query, up to the limit", () => {
    expect(names("  ", 2)).toEqual(["alpha", "beta"]);
  });

  it("reads a /regex/flags query", () => {
    expect(names("/^ALPHA/i")).toEqual(["alpha"]);
  });

  it("rejects a query that is not a valid regex", () => {
    expect(() => names("(")).toThrow("Invalid regex query");
  });
});

describe("actionToolOutput", () => {
  const interaction = {
    status: "pending_interaction",
    interaction: {
      appId: "maps",
      promptText: "pick a place",
      render: { kind: "inline", componentId: "picker", props: {} },
    },
  } as unknown as ActionResult;
  const placement = {
    status: "place_widget",
    placement: { appId: "maps", route: "/near", params: { q: "x" } },
  } as unknown as ActionResult;

  it("returns an action's data, or the result when it has none", () => {
    expect(actionToolOutput({ status: "ok", data: { id: 1 } }, true)).toEqual({ id: 1 });
    expect(actionToolOutput({ status: "ok" }, true)).toEqual({ status: "ok" });
  });

  it("passes an error result through as data", () => {
    const result: ActionResult = { status: "error", error: "name taken" };

    expect(actionToolOutput(result, true)).toBe(result);
  });

  it("tells the model an approval is pending, wherever it runs", () => {
    const result = {
      status: "pending_approval",
      approval: { approvalId: "a1", actionName: "send" },
    } as unknown as ActionResult;

    expect(actionToolOutput(result, false)).toMatchObject({
      pendingApproval: true,
      approvalId: "a1",
    });
  });

  it("hands the drain a component to mount where a widget shows", () => {
    expect(actionToolOutput(interaction, true)).toMatchObject({
      pendingInteraction: true,
      appId: "maps",
      render: { componentId: "picker" },
    });
  });

  it("has the model ask in a plain message where no widget shows", () => {
    const output = actionToolOutput(interaction, false) as { message: string };

    expect(output).not.toHaveProperty("pendingInteraction");
    expect(output.message).toContain("pick a place");
  });

  it("places a widget without parking the turn", () => {
    expect(actionToolOutput(placement, true)).toMatchObject({
      placeWidget: true,
      appId: "maps",
      route: "/near",
      params: { q: "x" },
    });
  });

  it("says a widget could not be placed where none shows", () => {
    const output = actionToolOutput(placement, false) as { message: string };

    expect(output).not.toHaveProperty("placeWidget");
    expect(output.message).toContain("could not be shown");
  });
});

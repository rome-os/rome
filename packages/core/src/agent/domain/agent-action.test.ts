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

  describe("show_widget", () => {
    const shown = (waits?: boolean): ActionResult => ({
      status: "show_widget",
      widget: {
        componentId: "today",
        props: { date: "2026-11-11" },
        text: "Showing today's meals as a card.",
        ...(waits === undefined ? {} : { waits }),
      },
    });

    it("shows the owner app's card and lets the turn go on", () => {
      const output = actionToolOutput(shown(), true, "meals") as Record<string, unknown>;

      expect(output).toMatchObject({
        showWidget: true,
        appId: "meals",
        componentId: "today",
        props: { date: "2026-11-11" },
        text: "Showing today's meals as a card.",
      });
      expect(output).not.toHaveProperty("pendingInteraction");
      expect(output.message).toContain("Showing today's meals as a card.");
      expect(output.message).not.toContain("do not call any further tools");
    });

    it("gives a widget that waits the same output as a pending interaction", () => {
      const legacy: ActionResult = {
        status: "pending_interaction",
        interaction: {
          appId: "meals",
          promptText: "Showing today's meals as a card.",
          render: { kind: "inline", componentId: "today", props: { date: "2026-11-11" } },
        },
      };

      expect(actionToolOutput(shown(true), true, "meals")).toEqual(actionToolOutput(legacy, true));
      expect(actionToolOutput(shown(true), false, "meals")).toEqual(
        actionToolOutput(legacy, false),
      );
    });

    it("tells the model no card showed where none can", () => {
      const output = actionToolOutput(shown(), false, "meals") as Record<string, unknown>;

      expect(output).not.toHaveProperty("showWidget");
      expect(output.message).toContain("could not be shown");
      expect(output.message).toContain("Showing today's meals as a card.");
    });

    describe("described as data", () => {
      const ui = {
        components: [
          {
            id: "root",
            component: "Stat" as const,
            label: "Calories",
            value: { path: "/today/calories" },
          },
        ],
      };
      const described = (u: unknown = ui): ActionResult => ({
        status: "show_widget",
        widget: {
          ui: u as typeof ui,
          bind: { "/today": "days/2026-11-11" },
          text: "Showing today's meals.",
        },
      });

      it("hands the drain the owner app's card and its bindings", () => {
        const output = actionToolOutput(described(), true, "meals") as Record<string, unknown>;

        expect(output).toMatchObject({
          showWidget: true,
          appId: "meals",
          ui,
          bind: { "/today": "days/2026-11-11" },
          text: "Showing today's meals.",
        });
        expect(output).not.toHaveProperty("componentId");
      });

      it("parks the agent on a described card that waits", () => {
        const waiting: ActionResult = {
          status: "show_widget",
          widget: { ui, text: "Asking which meal to log.", waits: true },
        };
        const output = actionToolOutput(waiting, true, "meals") as Record<string, unknown>;
        expect(output).toMatchObject({ showWidget: true, waits: true, appId: "meals", ui });
        expect(output.message).toContain("do not call any further tools");
      });

      it("tells the model to wait for the reply where a card that waits cannot show", () => {
        const waiting: ActionResult = {
          status: "show_widget",
          widget: { ui, text: "Asking which meal to log.", waits: true },
        };
        const output = actionToolOutput(waiting, false, "meals") as Record<string, unknown>;
        expect(output).not.toHaveProperty("showWidget");
        expect(output.message).toContain("wait for their reply");
      });

      it("tells the model why a card that fails the check showed nowhere", () => {
        const bad = { components: [{ id: "top", component: "Text", text: "a" }] };
        const output = actionToolOutput(described(bad), true, "meals") as Record<string, unknown>;

        expect(output).not.toHaveProperty("showWidget");
        expect(output.message).toContain('"root"');
        expect(output.message).toContain("Showing today's meals.");
      });

      it("tells the model no card showed where none can", () => {
        const output = actionToolOutput(described(), false, "meals") as Record<string, unknown>;

        expect(output).not.toHaveProperty("showWidget");
        expect(output.message).toContain("could not be shown");
      });
    });

    it("shows no card for an action no app owns", () => {
      const output = actionToolOutput(shown(), true, undefined) as Record<string, unknown>;

      expect(output).not.toHaveProperty("showWidget");
      expect(output).not.toHaveProperty("appId");
    });
  });
});

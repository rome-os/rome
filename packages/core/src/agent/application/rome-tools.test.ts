import { describe, expect, it, rs } from "@rstest/core";
import type { AgentPolicy } from "../domain/agent-policy.js";
import type { RomeTool } from "../domain/rome-tools.js";
import type { TurnFacts } from "../domain/turn-facts.js";
import { createRomeTools, type RomeToolsOptions } from "./rome-tools.js";

const TURN: TurnFacts = {
  agentName: "core:main",
  continuityKey: "test",
  sessionId: "session-1",
  isSubagent: false,
  actions: ["*"],
  widgets: "plain_text",
  turnId: () => "turn-1",
  threadContext: () => undefined,
  sharedContext: () => undefined,
  pushLevel: () => undefined,
  actor: () => undefined,
  reportedTask: () => undefined,
  inTurn: (fn) => fn(),
};

function tools(overrides: Partial<RomeToolsOptions> = {}) {
  return createRomeTools({
    turn: TURN,
    actions: {
      list: () => [],
      permits: () => true,
      appOf: () => undefined,
      run: async () => ({ status: "ok" }),
    },
    skills: { list: () => [] },
    subagents: { list: () => [], run: async () => ({}) },
    widgetsShow: false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  });
}

const askUserNames = (overrides: Partial<RomeToolsOptions> = {}) =>
  tools(overrides)
    .listTools("ask_user")
    .map((tool) => tool.name);

const multi = (options: unknown) => ({
  questions: [{ id: "q1", question: "Pick any", type: "multi", options }],
});

function askQuestion(widgetsShow: boolean, input: Record<string, unknown>) {
  return tools({ widgetsShow }).callTool("ask_user", "ask_question", input);
}

const QUESTIONS = {
  questions: [
    { id: "weekend", question: "Which weekend?", type: "single", options: ["This", "Next"] },
    { id: "city", question: "Which city?", type: "text" },
  ],
};

async function handlerText(widgetsShow: boolean): Promise<string> {
  const res = await askQuestion(widgetsShow, QUESTIONS);
  return res.content[0].text;
}

describe("ask_question", () => {
  it("relays the questions as prose where no widget shows", async () => {
    const text = await handlerText(false);
    expect(text).toBe(
      "This surface cannot render an interactive UI. Ask the guardian the " +
        "following as a plain message, then wait for their reply before doing " +
        "anything else:\n\nWhich weekend?\n- This\n- Next\n\nWhich city?",
    );
    expect(text).toContain("Which weekend?");
    expect(text).toContain("- This");
    expect(text).toContain("- Next");
    expect(text).toContain("Which city?");
  });

  it("relays defaults and option descriptions as readable prose", async () => {
    const input = {
      questions: [
        {
          id: "kinds",
          question: "Which events?",
          type: "multi",
          options: ["Reviews", "Issues"],
          defaults: ["Reviews"],
          optionDescriptions: {
            Reviews: "Requests for review.",
            Issues: "New issues in the repository.",
          },
        },
        {
          id: "scope",
          question: "Which scope?",
          type: "single",
          options: ["Mine", "All"],
          defaults: ["Mine"],
        },
        {
          id: "preference",
          question: "Anything else?",
          type: "text",
          optional: true,
          defaultText: "Billing only",
        },
        {
          id: "people",
          question: "Ignore which people?",
          type: "text",
          optional: true,
          defaultText: "",
        },
      ],
    };
    const prose = (await askQuestion(false, input)) as { content: { text: string }[] };
    expect(prose.content[0].text).toContain(
      "Which events? (pick any that apply)\n- Reviews (default) — Requests for review.\n- Issues — New issues in the repository.\n\nWhich scope?\n- Mine (default)\n- All\n\nAnything else? (optional)\nDefault: Billing only\n\nIgnore which people? (optional)\nDefault: (empty)",
    );
    const card = (await askQuestion(true, input)) as { content: { text: string }[] };
    expect(JSON.parse(card.content[0].text).render.props).toEqual(input);
  });

  it("fails closed before rendering or relaying malformed defaults", async () => {
    for (const surface of [true, false]) {
      const result = await askQuestion(surface, {
        questions: [{ id: "q", question: "Pick", type: "single", options: ["A"], defaults: ["B"] }],
      });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain("pendingInteraction");
    }
  });

  it("returns the built-in question-card payload where a widget shows", async () => {
    const payload = JSON.parse(await handlerText(true)) as {
      pendingInteraction: boolean;
      render: { builtin: boolean; componentId: string };
    };
    expect(payload.pendingInteraction).toBe(true);
    expect(payload.render.builtin).toBe(true);
    expect(payload.render.componentId).toBe("question-card");
  });

  it("hints the free-text escape on a freeText single-choice in the plain message", async () => {
    const input = {
      questions: [
        { id: "q1", question: "Pick one", type: "single", options: ["A"], freeText: true },
      ],
    };
    const res = await askQuestion(false, input);
    const text = res.content[0].text;
    expect(text).toContain("- A");
    expect(text).toContain("(or describe your own)");
  });

  it("passes freeText through to the question-card payload", async () => {
    const input = {
      questions: [
        { id: "q1", question: "Pick one", type: "single", options: ["A"], freeText: true },
      ],
    };
    const res = await askQuestion(true, input);
    const payload = JSON.parse(res.content[0].text) as {
      render: { props: { questions: { freeText?: boolean }[] } };
    };
    expect(payload.render.props.questions[0].freeText).toBe(true);
  });

  it("renders multi-choice options with a pick-any hint in the plain message", async () => {
    const input = {
      questions: [
        {
          id: "q1",
          question: "Which areas?",
          type: "multi",
          options: ["AI", "Design"],
          freeText: true,
        },
      ],
    };
    const res = await askQuestion(false, input);
    const text = res.content[0].text;
    expect(text).toContain("Which areas? (pick any that apply)");
    expect(text).toContain("- AI");
    expect(text).toContain("- Design");
    expect(text).toContain("(or describe your own)");
  });

  it("passes the multi type through to the question-card payload", async () => {
    const res = await askQuestion(true, multi(["A", "B"]));
    const payload = JSON.parse(res.content[0].text) as {
      render: { props: { questions: { type?: string }[] } };
    };
    expect(payload.render.props.questions[0].type).toBe("multi");
  });

  it("marks optional questions and passes the flag through", async () => {
    const input = {
      questions: [{ id: "q1", question: "Anything else?", type: "text", optional: true }],
    };
    const prose = await askQuestion(false, input);
    expect(prose.content[0].text).toContain("Anything else? (optional)");

    const card = await askQuestion(true, input);
    const payload = JSON.parse(card.content[0].text) as {
      render: { props: { questions: { optional?: boolean }[] } };
    };
    expect(payload.render.props.questions[0].optional).toBe(true);
  });
});

describe("defer", () => {
  const defer = (finalText: AgentPolicy["finalText"] = "deliver") => ({
    schedule: rs.fn().mockResolvedValue({ ok: true }),
    finalText,
  });

  it("is absent for a session with no thread to wake", () => {
    expect(askUserNames()).not.toContain("defer");
  });

  it("is served wherever a thread can be woken, with no widget needed", () => {
    expect(askUserNames({ defer: defer(), widgetsShow: false })).toContain("defer");
  });

  it("schedules the parsed wake-up and returns what the schedule answers", async () => {
    const schedule = rs
      .fn()
      .mockResolvedValue({ ok: true, deferredUntil: "2026-06-25T12:05:00.000Z" });
    const result = await tools({ defer: { schedule, finalText: "deliver" } }).callTool(
      "ask_user",
      "defer",
      { name: "check CI", note: "Read CI run 42 and tell the guardian.", afterMinutes: 5 },
    );
    expect(schedule).toHaveBeenCalledWith(TURN, {
      kind: "time",
      name: "check CI",
      note: "Read CI run 42 and tell the guardian.",
      fireAtMs: expect.any(Number),
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("2026-06-25T12:05:00.000Z");
  });

  it("waits for an event without a label or a deadline, for an agent whose policy asks for neither", async () => {
    const schedule = rs.fn().mockResolvedValue({ ok: true, waitingFor: "ci.done" });
    const served = tools({ defer: { schedule, finalText: "deliver" } })
      .listTools("ask_user")
      .find((tool) => tool.name === "defer");
    const event = (served?.inputSchema as { properties: { event: Record<string, unknown> } })
      .properties.event as { required: string[]; properties: Record<string, unknown> };
    expect(event.required).toEqual(["eventName"]);
    expect(event.properties).not.toHaveProperty("deadline");
    const result = await tools({ defer: { schedule, finalText: "deliver" } }).callTool(
      "ask_user",
      "defer",
      { name: "CI", note: "Read the run.", event: { eventName: "ci.done" } },
    );
    expect(result.isError).toBeFalsy();
    expect(schedule).toHaveBeenCalledWith(TURN, {
      kind: "event",
      name: "CI",
      note: "Read the run.",
      event: { eventName: "ci.done" },
    });
  });

  it("names no task for an agent whose policy checks none", async () => {
    const schedule = rs.fn().mockResolvedValue({ ok: true });
    const served = tools({ defer: { schedule, finalText: "deliver" } });
    const schema = served.listTools("ask_user").find((tool) => tool.name === "defer")
      ?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("taskId");
    const refused = await served.callTool("ask_user", "defer", {
      name: "CI",
      note: "Read the run.",
      afterMinutes: 5,
      taskId: "task-1",
    });
    expect(refused.isError).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("tells an agent that checks tasks only what it can do when it wakes", () => {
    const description = (taskChecks: boolean) =>
      tools({ defer: { schedule: rs.fn(), finalText: "private", taskChecks } })
        .listTools("ask_user")
        .find((tool) => tool.name === "defer")?.description ?? "";
    const checks = description(true);
    expect(checks).not.toContain("search_event_catalog");
    expect(checks).not.toContain("whole conversation still in context");
    expect(checks).not.toContain("no limit on re-defers");
    expect(checks).toContain("a newer session may be the one that wakes");
    // A check still pending is checked again, so the task stays later until
    // the digest asks after three.
    expect(checks).toContain("`defer` again (minimum one minute) while it is still pending");
    expect(checks).not.toContain("only when something changed");
    const plain = description(false);
    expect(plain).toContain("search_event_catalog");
    expect(plain).toContain("no limit on re-defers");
  });

  it("asks for a label and a deadline on an event wait when the agent's policy does", async () => {
    const schedule = rs.fn().mockResolvedValue({ ok: true });
    const served = tools({ defer: { schedule, finalText: "private", taskChecks: true } });
    const event = (
      served.listTools("ask_user").find((tool) => tool.name === "defer")?.inputSchema as {
        properties: { event: { required: string[] } };
      }
    ).properties.event;
    expect(event.required).toEqual(["eventName", "waitingFor", "deadline"]);
    const refused = await served.callTool("ask_user", "defer", {
      name: "CI",
      note: "Read the run.",
      event: { eventName: "ci.done" },
    });
    expect(refused.isError).toBe(true);
    expect(schedule).not.toHaveBeenCalled();
  });

  // A private-text agent can confirm only with another message, which repeats
  // what it already told the guardian.
  it.each([
    ["deliver", true],
    ["private", false],
  ] as const)("with %s final text, asks for a confirmation line: %s", (finalText, confirms) => {
    const served = tools({ defer: defer(finalText) })
      .listTools("ask_user")
      .find((tool) => tool.name === "defer");
    expect(served?.description.includes("write one short line confirming")).toBe(confirms);
    expect(served?.description).toContain("end your turn");
  });

  it("refuses a wake-up in the past without scheduling it", async () => {
    const schedule = rs.fn();
    const result = await tools({ defer: { schedule, finalText: "deliver" } }).callTool(
      "ask_user",
      "defer",
      { note: "n", name: "x", at: "2020-01-01T00:00:00Z" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("defer fires in the past");
    expect(schedule).not.toHaveBeenCalled();
  });

  it("surfaces a schedule's error as a tool error", async () => {
    const schedule = rs.fn().mockRejectedValue(new Error("no thread to wake"));
    const result = await tools({ defer: { schedule, finalText: "deliver" } }).callTool(
      "ask_user",
      "defer",
      { note: "n", name: "x", afterMinutes: 5 },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no thread to wake");
  });
});

describe("session tools", () => {
  const say = (handler: RomeTool["handler"]): RomeTool => ({
    name: "say",
    description: "Speak",
    inputSchema: { type: "object" },
    handler,
  });

  it("are served after defer wherever the session runs, and none by default", async () => {
    const handler = rs.fn().mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
    const defer = { schedule: async () => ({}), finalText: "deliver" as const };
    expect(askUserNames()).toEqual(["ask_question"]);
    expect(askUserNames({ defer, sessionTools: [say(handler)] })).toEqual([
      "ask_question",
      "defer",
      "say",
    ]);
    await tools({ sessionTools: [say(handler)] }).callTool("ask_user", "say", { text: "hi" });
    expect(handler).toHaveBeenCalledWith({ text: "hi" }, undefined);
  });
});

describe("execute_action", () => {
  const callAction = (widgetsShow: boolean) =>
    tools({
      widgetsShow,
      actions: {
        list: () => [],
        permits: () => true,
        appOf: () => undefined,
        run: async () => ({
          status: "place_widget",
          placement: { appId: "maps" },
        }),
      },
    }).callTool("actions", "execute_action", { action_name: "show", json_args: {} });

  it("shapes the action's result by whether a widget shows", async () => {
    expect((await callAction(true)).content[0].text).toContain('"placeWidget":true');
    expect((await callAction(false)).content[0].text).toContain("could not be shown");
  });

  it("shows a widget as the app that owns the action", async () => {
    const result = await tools({
      widgetsShow: true,
      actions: {
        list: () => [],
        permits: () => true,
        appOf: (name) => (name === "show_today" ? "meals" : undefined),
        run: async () => ({
          status: "show_widget",
          widget: { componentId: "today", text: "Showing today's meals." },
        }),
      },
    }).callTool("actions", "execute_action", { action_name: "show_today", json_args: {} });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      showWidget: true,
      appId: "meals",
      componentId: "today",
    });
  });

  it("turns an unknown action into an error result", async () => {
    const result = await tools({
      actions: {
        list: () => [],
        permits: () => false,
        appOf: () => undefined,
        run: async (_turn, name) => {
          throw new Error(`Unknown action: ${name}`);
        },
      },
    }).callTool("actions", "execute_action", { action_name: "nope", json_args: {} });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe("Unknown action: nope");
  });
});

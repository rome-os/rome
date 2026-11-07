import { describe, expect, it, rs } from "@rstest/core";
import type { AgentPolicy } from "../domain/agent-policy.js";
import type { RomeTool } from "../domain/rome-tools.js";
import { createRomeTools, type RomeToolsOptions } from "./rome-tools.js";

function tools(overrides: Partial<RomeToolsOptions> = {}) {
  return createRomeTools({
    actions: { list: () => [], run: async () => ({ status: "ok" }) },
    skills: { list: () => [] },
    subagents: { tools: [], run: async () => ({}) },
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
    expect(text).not.toContain("pendingInteraction");
    expect(text).toContain("Which weekend?");
    expect(text).toContain("- This");
    expect(text).toContain("- Next");
    expect(text).toContain("Which city?");
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

  it("relays the call and returns what the schedule answers", async () => {
    const schedule = rs
      .fn()
      .mockResolvedValue({ ok: true, deferredUntil: "2026-06-25T12:05:00.000Z" });
    const result = await tools({ defer: { schedule, finalText: "deliver" } }).callTool(
      "ask_user",
      "defer",
      { name: "check CI", afterMinutes: 5 },
    );
    expect(schedule).toHaveBeenCalledWith({ name: "check CI", afterMinutes: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("2026-06-25T12:05:00.000Z");
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

  it("surfaces a thrown error as a tool error", async () => {
    const schedule = rs.fn().mockRejectedValue(new Error("defer fires in the past"));
    const result = await tools({ defer: { schedule, finalText: "deliver" } }).callTool(
      "ask_user",
      "defer",
      { name: "x", at: "2020-01-01T00:00:00Z" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("defer fires in the past");
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

  it("turns an unknown action into an error result", async () => {
    const result = await tools({
      actions: {
        list: () => [],
        run: async (name) => {
          throw new Error(`Unknown action: ${name}`);
        },
      },
    }).callTool("actions", "execute_action", { action_name: "nope", json_args: {} });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe("Unknown action: nope");
  });
});

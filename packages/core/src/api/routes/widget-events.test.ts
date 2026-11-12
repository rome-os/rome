import { describe, expect, it } from "@rstest/core";
import { widgetEventRoutes } from "./widget-events.js";

const button = (id: string, name: string, context?: unknown) => ({
  id,
  component: "Button",
  child: `${id}-label`,
  action: { event: { name, ...(context ? { context } : {}) } },
});

const mealWidget = (toolUseId: string, appId: string, event: string) => ({
  type: "widget",
  toolUseId,
  appId,
  text: "Today",
  ui: {
    components: [{ id: "root", component: "Column", children: ["press"] }, button("press", event)],
  },
});

const question = {
  type: "pending_interaction",
  toolUseId: "q1",
  appId: "core",
  render: {
    kind: "inline",
    componentId: "question-card",
    builtin: true,
    ui: {
      components: [
        { id: "root", component: "Column", children: ["send", "dismiss"] },
        button("send", "rome:answer", { answers: { path: "/answers" } }),
        button("dismiss", "rome:dismiss"),
      ],
    },
  },
};

interface Row {
  chatId: string;
  content: unknown[];
}

/** The route with its messages, its chats (`private` = the guardian's own), and a caller. */
function setup(rows: Record<string, Row>, caller: string | null = "guardian") {
  const forwarded: { url: string; body: unknown; cookie: string | null }[] = [];
  const app = widgetEventRoutes({
    webchatRepo: {
      sessionIdOfMessage: async (id) => rows[id]?.chatId ?? null,
      getMessageContent: async (id) => (rows[id] ? JSON.stringify(rows[id].content) : null),
      getSession: (async (id: string) =>
        id === "private"
          ? { id, agentName: "core:concierge", ownerKey: "guardian", triggerKind: null }
          : { id, agentName: null, ownerKey: null, triggerKind: null }) as never,
    },
    callerOwner: async () => caller,
    forward: async (request) => {
      forwarded.push({
        url: new URL(request.url).pathname,
        body: await request.json(),
        cookie: request.headers.get("cookie"),
      });
      return Response.json({ ok: true });
    },
  });
  const fire = (widgetId: string, body: unknown) =>
    app.request(`/chat/widgets/${widgetId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "rome_session=x" },
      body: JSON.stringify(body),
    });
  return { fire, forwarded };
}

describe("an event on a widget", () => {
  it("calls the widget's app with the event's context, as the caller", async () => {
    const { fire, forwarded } = setup({
      m1: { chatId: "c1", content: [mealWidget("w1", "@alice/meals", "water")] },
    });
    const res = await fire("m1", { name: "water", context: { cups: 1 } });
    expect(res.status).toBe(200);
    expect(forwarded).toEqual([
      { url: "/api/apps/%40alice%2Fmeals/water", body: { cups: 1 }, cookie: "rome_session=x" },
    ]);
  });

  it("answers the agent waiting on the widget as a turn in its chat", async () => {
    const { fire, forwarded } = setup({ m2: { chatId: "c1", content: [question] } });
    await fire("m2", {
      name: "rome:answer",
      context: { answers: [{ values: ["Warm"], text: "" }] },
      turn: { personaId: "p1" },
    });
    expect(forwarded).toEqual([
      {
        url: "/api/chat/sessions/c1/turns",
        body: {
          personaId: "p1",
          parts: [
            {
              type: "interaction_result",
              toolUseId: "q1",
              output: { answers: [{ values: ["Warm"], text: "" }] },
            },
          ],
        },
        cookie: "rome_session=x",
      },
    ]);
  });

  it("handles the question card's own send and dismiss in core", async () => {
    const card = structuredClone(question);
    card.render.ui.components = [
      { id: "root", component: "Column", children: ["send", "dismiss"] },
      button("send", "send", { answers: { path: "/answers" } }),
      button("dismiss", "dismiss"),
    ];
    const { fire, forwarded } = setup({ m3: { chatId: "c1", content: [card] } });
    await fire("m3", { name: "send", context: { answers: [{ values: ["Warm"], text: "" }] } });
    await fire("m3", { name: "dismiss" });
    expect(forwarded.map((f) => f.body)).toEqual([
      {
        parts: [
          {
            type: "interaction_result",
            toolUseId: "q1",
            output: { answers: [{ values: ["Warm"], text: "" }] },
          },
        ],
      },
      { parts: [{ type: "interaction_result", toolUseId: "q1", output: { dismissed: true } }] },
    ]);
  });

  it("sends an app widget's event named send to the app, not to the agent", async () => {
    const { fire, forwarded } = setup({
      m1: { chatId: "c1", content: [mealWidget("w1", "notes", "send")] },
    });
    await fire("m1", { name: "send", context: { to: "team" } });
    expect(forwarded.map((f) => f.url)).toEqual(["/api/apps/notes/send"]);
  });

  it("dismisses with the output every dismissal has", async () => {
    const { fire, forwarded } = setup({ m2: { chatId: "c1", content: [question] } });
    await fire("m2", { name: "rome:dismiss", context: { ignored: true } });
    expect(forwarded[0]?.body).toEqual({
      parts: [{ type: "interaction_result", toolUseId: "q1", output: { dismissed: true } }],
    });
  });

  it("refuses an event the widget does not declare", async () => {
    const { fire, forwarded } = setup({
      m1: { chatId: "c1", content: [mealWidget("w1", "meals", "water")] },
    });
    expect((await fire("m1", { name: "settings" })).status).toBe(400);
    expect((await fire("m1", { name: "rome:answer" })).status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it("answers the agent only on a widget it waits on", async () => {
    const widget = mealWidget("w1", "meals", "water");
    widget.ui.components.push(button("send", "rome:answer"));
    const { fire, forwarded } = setup({ m1: { chatId: "c1", content: [widget] } });
    expect((await fire("m1", { name: "rome:answer" })).status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it("reaches only the widget pressed, whatever tool-use ids the provider reuses", async () => {
    const { fire, forwarded } = setup({
      older: { chatId: "c1", content: [mealWidget("item_0", "todos", "delete")] },
      newer: { chatId: "c1", content: [mealWidget("item_0", "notes", "delete")] },
    });
    await fire("older", { name: "delete" });
    expect(forwarded.map((f) => f.url)).toEqual(["/api/apps/todos/delete"]);
  });

  it("is not found to a caller who may not open its chat, checked by the route itself", async () => {
    const { fire, forwarded } = setup(
      { m1: { chatId: "private", content: [mealWidget("w1", "meals", "water")] } },
      "visitor:someone",
    );
    expect((await fire("m1", { name: "water" })).status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it("is not found when the message holds no widget, or more than one part", async () => {
    const { fire } = setup({
      text: { chatId: "c1", content: [{ type: "text", content: "hi" }] },
      two: {
        chatId: "c1",
        content: [mealWidget("w1", "meals", "water"), { type: "text", content: "hi" }],
      },
    });
    expect((await fire("text", { name: "water" })).status).toBe(404);
    expect((await fire("two", { name: "water" })).status).toBe(404);
    expect((await fire("missing", { name: "water" })).status).toBe(404);
  });
});

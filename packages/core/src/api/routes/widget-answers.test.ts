import { describe, expect, it } from "@rstest/core";
import { widgetAnswerRoutes } from "./widget-answers.js";

const button = (id: string, name: string, context?: unknown) => ({
  id,
  component: "Button",
  child: `${id}-label`,
  action: { event: { name, ...(context ? { context } : {}) } },
});

const mealWidget = {
  type: "widget",
  toolUseId: "w1",
  appId: "@alice/meals",
  text: "Today",
  ui: {
    components: [
      { id: "root", component: "Column", children: ["water"] },
      button("water", "water"),
    ],
  },
};

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

function setup(parts: unknown[]) {
  const forwarded: { url: string; body: unknown; cookie: string | null }[] = [];
  const app = widgetAnswerRoutes({
    webchatRepo: {
      getMessages: async () => [{ role: "assistant", content: JSON.stringify(parts) }] as never,
    },
    forward: async (request) => {
      forwarded.push({
        url: new URL(request.url).pathname,
        body: await request.json(),
        cookie: request.headers.get("cookie"),
      });
      return Response.json({ ok: true });
    },
  });
  const answer = (toolUseId: string, body: unknown) =>
    app.request(`/chat/sessions/s1/widgets/${toolUseId}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "rome_session=x" },
      body: JSON.stringify(body),
    });
  return { answer, forwarded };
}

describe("answering a widget", () => {
  it("calls the widget's app with the event's context, as the caller", async () => {
    const { answer, forwarded } = setup([mealWidget]);
    const res = await answer("w1", { name: "water", context: { cups: 1 } });
    expect(res.status).toBe(200);
    expect(forwarded).toEqual([
      { url: "/api/apps/%40alice%2Fmeals/water", body: { cups: 1 }, cookie: "rome_session=x" },
    ]);
  });

  it("answers the interaction the agent waits on as a turn in the chat", async () => {
    const { answer, forwarded } = setup([question]);
    await answer("q1", {
      name: "rome:answer",
      context: { answers: [{ values: ["Warm"], text: "" }] },
      turn: { personaId: "p1" },
    });
    expect(forwarded).toEqual([
      {
        url: "/api/chat/sessions/s1/turns",
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

  it("dismisses with the output every dismissal has", async () => {
    const { answer, forwarded } = setup([question]);
    await answer("q1", { name: "rome:dismiss", context: { ignored: true } });
    expect(forwarded[0]?.body).toEqual({
      parts: [{ type: "interaction_result", toolUseId: "q1", output: { dismissed: true } }],
    });
  });

  it("refuses an event no button on the stored widget declares", async () => {
    const { answer, forwarded } = setup([mealWidget]);
    expect((await answer("w1", { name: "settings" })).status).toBe(400);
    expect((await answer("w1", { name: "rome:answer" })).status).toBe(400);
    expect((await answer("missing", { name: "water" })).status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it("answers the agent only on a widget it waits on", async () => {
    const card = {
      ...mealWidget,
      ui: { components: [...mealWidget.ui.components, button("send", "rome:answer")] },
    };
    const { answer, forwarded } = setup([card]);
    expect((await answer("w1", { name: "rome:answer" })).status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it("reads the latest widget when a turn reused its id", async () => {
    const later = { ...mealWidget, ui: { components: [button("root", "refill")] } };
    const { answer, forwarded } = setup([mealWidget, later]);
    expect((await answer("w1", { name: "water" })).status).toBe(400);
    expect((await answer("w1", { name: "refill" })).status).toBe(200);
    expect(forwarded.map((f) => f.url)).toEqual(["/api/apps/%40alice%2Fmeals/refill"]);
  });
});

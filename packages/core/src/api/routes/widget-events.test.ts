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
function setup(
  rows: Record<string, Row>,
  caller: string | null = "guardian",
  appReply: unknown = { ok: true },
) {
  const forwarded: { url: string; body: unknown; cookie: string | null }[] = [];
  const app = widgetEventRoutes({
    webchatRepo: {
      widgetMessage: async (id) =>
        rows[id] ? { chatId: rows[id].chatId, content: JSON.stringify(rows[id].content) } : null,
      getMessages: (async (chatId: string) =>
        Object.entries(rows)
          .filter(([, row]) => row.chatId === chatId)
          .map(([id, row]) => ({
            id,
            role: row.content.some(
              (part) => (part as { type?: string }).type === "interaction_result",
            )
              ? "user"
              : "assistant",
            content: JSON.stringify(row.content),
          }))) as never,
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
      return Response.json(
        new URL(request.url).pathname.startsWith("/api/apps/") ? appReply : { ok: true },
      );
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
              messageId: "m2",
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
            messageId: "m3",
            output: { answers: [{ values: ["Warm"], text: "" }] },
          },
        ],
      },
      {
        parts: [
          {
            type: "interaction_result",
            toolUseId: "q1",
            messageId: "m3",
            output: { dismissed: true },
          },
        ],
      },
    ]);
  });

  it("sends an app widget's event named send to the app, not to the agent", async () => {
    const { fire, forwarded } = setup({
      m1: { chatId: "c1", content: [mealWidget("w1", "notes", "send")] },
    });
    await fire("m1", { name: "send", context: { to: "team" } });
    expect(forwarded.map((f) => f.url)).toEqual(["/api/apps/notes/send"]);
  });

  it("answers the agent waiting on an app's widget with the app's reply, labelled as the app's", async () => {
    const connect = {
      type: "pending_interaction",
      toolUseId: "tu-connect",
      appId: "connector",
      render: {
        kind: "inline",
        ui: {
          components: [{ id: "root", component: "Column", children: [] }, button("check", "check")],
        },
      },
    };
    const { fire, forwarded } = setup({ m4: { chatId: "c1", content: [connect] } }, "guardian", {
      answer: { toolkit: "gmail", status: "connected" },
    });
    const res = await fire("m4", { name: "check", context: { toolkit: "gmail" } });
    expect(await res.json()).toMatchObject({ answered: true });
    expect(forwarded.map((f) => [f.url, f.body])).toEqual([
      ["/api/apps/connector/check", { toolkit: "gmail" }],
      [
        "/api/chat/sessions/c1/turns",
        {
          parts: [
            {
              type: "interaction_result",
              toolUseId: "tu-connect",
              messageId: "m4",
              output: { from: "connector", value: { toolkit: "gmail", status: "connected" } },
            },
          ],
        },
      ],
    ]);
  });

  it("leaves the agent waiting when the app's reply does not answer", async () => {
    const connect = {
      type: "pending_interaction",
      toolUseId: "tu-connect",
      appId: "connector",
      render: {
        kind: "inline",
        ui: {
          components: [
            { id: "root", component: "Column", children: [] },
            button("connect", "connect"),
          ],
        },
      },
    };
    const { fire, forwarded } = setup({ m5: { chatId: "c1", content: [connect] } }, "guardian", {
      open: "https://auth.example.com/authorize",
    });
    const res = await fire("m5", { name: "connect" });
    expect(await res.json()).toEqual({ open: "https://auth.example.com/authorize" });
    expect(forwarded.map((f) => f.url)).toEqual(["/api/apps/connector/connect"]);
  });

  it("writes what the client reads itself, never a field of the app's own", async () => {
    const connect = {
      type: "pending_interaction",
      toolUseId: "tu-connect",
      appId: "connector",
      render: {
        kind: "inline",
        ui: {
          components: [
            { id: "root", component: "Column", children: [] },
            button("connect", "connect"),
          ],
        },
      },
    };
    const said = async (reply: unknown) => {
      const { fire, forwarded } = setup(
        { m6: { chatId: "c1", content: [connect] } },
        "guardian",
        reply,
      );
      const res = await fire("m6", { name: "connect" });
      return { body: await res.json(), forwarded: forwarded.map((f) => f.url) };
    };
    // The app says it answered, but gave no answer: the agent still waits.
    expect(await said({ answered: true, extra: 1 })).toEqual({
      body: {},
      forwarded: ["/api/apps/connector/connect"],
    });
    // A link opens only when it is https or a page of this instance.
    expect((await said({ open: "http://evil.example/x" })).body).toEqual({});
    expect((await said({ open: "javascript:alert(1)" })).body).toEqual({});
    expect((await said({ open: "/settings/connections" })).body).toEqual({
      open: "http://localhost/settings/connections",
    });
  });

  it("reads an app's answer that declines as a dismissal, and passes on why an app refused", async () => {
    const connect = {
      type: "pending_interaction",
      toolUseId: "tu-connect",
      appId: "connector",
      render: {
        kind: "inline",
        ui: {
          components: [
            { id: "root", component: "Column", children: [] },
            button("dismiss", "connect-card/dismiss"),
            button("connect", "connect-card/connect"),
          ],
        },
      },
    };
    const declined = setup({ m7: { chatId: "c1", content: [connect] } }, "guardian", {
      answer: { toolkit: "notion", dismissed: true },
    });
    await declined.fire("m7", { name: "connect-card/dismiss" });
    expect(declined.forwarded[1]?.body).toMatchObject({
      parts: [
        {
          output: {
            dismissed: true,
            from: "connector",
            value: { toolkit: "notion", dismissed: true },
          },
        },
      ],
    });

    const app = widgetEventRoutes({
      webchatRepo: {
        widgetMessage: async () => ({ chatId: "c1", content: JSON.stringify([connect]) }),
        getMessages: (async () => [
          { id: "m7", role: "assistant", content: JSON.stringify([connect]) },
        ]) as never,
        getSession: (async (id: string) => ({ id, ownerKey: null })) as never,
      },
      callerOwner: async () => "guardian",
      forward: async () =>
        Response.json(
          { error: "no_api_key", message: "Log in to Composio first" },
          { status: 409 },
        ),
    });
    const res = await app.request("/chat/widgets/m7/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "connect-card/connect" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Log in to Composio first" });
  });

  it("refuses an event on a card that was already answered, without calling its app", async () => {
    const connect = {
      type: "pending_interaction",
      toolUseId: "tu-connect",
      appId: "connector",
      render: {
        kind: "inline",
        ui: {
          components: [
            { id: "root", component: "Column", children: [] },
            button("connect", "connect"),
          ],
        },
      },
    };
    const { fire, forwarded } = setup({
      m9: { chatId: "c1", content: [connect] },
      r9: {
        chatId: "c1",
        content: [
          { type: "interaction_result", toolUseId: "tu-connect", messageId: "m9", output: {} },
        ],
      },
    });
    const res = await fire("m9", { name: "connect" });
    expect(res.status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it("dismisses with the output every dismissal has", async () => {
    const { fire, forwarded } = setup({ m2: { chatId: "c1", content: [question] } });
    await fire("m2", { name: "rome:dismiss", context: { ignored: true } });
    expect(forwarded[0]?.body).toEqual({
      parts: [
        {
          type: "interaction_result",
          toolUseId: "q1",
          messageId: "m2",
          output: { dismissed: true },
        },
      ],
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

describe("an event on a widget, over the dashboard's own storage", () => {
  it("finds a widget stored in a dashboard chat by the id clients know it by", async () => {
    const { createTestDb } = await import("../../test/helpers.js");
    const { TurnLinks } = await import("../../sessions/turn-links.js");
    const { ChatsWebChatRepository } = await import("../../webchat/chats-webchat-repository.js");
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db, { links: new TurnLinks(testDb.db) });
      await repo.createSession("chat-1", "Meals");
      const stored = await repo.addBackendMessage("chat-1", "turn-1", [
        mealWidget("item_0", "meals", "water") as never,
      ]);
      // A dashboard chat's lines live in Chats' tables, not the session's own.
      const { romeAgentMessages } = await import("../../db/schema.js");
      expect(testDb.db.select().from(romeAgentMessages).all()).toEqual([]);
      expect((await repo.getMessages("chat-1")).map((m) => m.id)).toContain(stored.id);
      const forwarded: string[] = [];
      const app = widgetEventRoutes({
        webchatRepo: repo,
        callerOwner: async () => "guardian",
        forward: async (request) => {
          forwarded.push(new URL(request.url).pathname);
          return Response.json({ ok: true });
        },
      });
      const res = await app.request(`/chat/widgets/${stored.id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "water", context: {} }),
      });
      expect(res.status).toBe(200);
      expect(forwarded).toEqual(["/api/apps/meals/water"]);
      await expect(
        repo.addBackendMessage("chat-1", "turn-1", [
          mealWidget("item_1", "meals", "water") as never,
          { type: "text", content: "and words" } as never,
        ]),
      ).rejects.toThrow();
    } finally {
      testDb.close();
    }
  });

  it("finds no widget by a key two dashboard chats share, so no chat is checked for another's widget", async () => {
    const { createTestDb } = await import("../../test/helpers.js");
    const { TurnLinks } = await import("../../sessions/turn-links.js");
    const { ChatsWebChatRepository } = await import("../../webchat/chats-webchat-repository.js");
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db, { links: new TurnLinks(testDb.db) });
      await repo.createSession("chat-1", "Mine");
      await repo.createSession("chat-2", "Theirs");
      const widget = JSON.stringify([mealWidget("item_0", "meals", "water")]);
      await repo.addMessage("dup", "chat-1", "assistant", widget);
      await repo.addMessage("dup", "chat-2", "assistant", widget);
      expect(await repo.widgetMessage("dup")).toBeNull();
    } finally {
      testDb.close();
    }
  });

  it("leaves a trace found by its own id when a dashboard line takes that id as its key", async () => {
    const { createTestDb } = await import("../../test/helpers.js");
    const { TurnLinks } = await import("../../sessions/turn-links.js");
    const { ChatsWebChatRepository } = await import("../../webchat/chats-webchat-repository.js");
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db, { links: new TurnLinks(testDb.db) });
      await repo.createSession("private", "Private");
      await repo.createSession("mine", "Mine");
      await repo.addMessage("trace-1", "private", "trace", "[]");
      // A client picks a user line's key, so it can pick a trace's id.
      await repo.addMessage(
        "trace-1",
        "mine",
        "user",
        JSON.stringify([{ type: "text", content: "hi" }]),
      );
      expect(await repo.sessionIdOfMessage("trace-1")).toBe("private");
    } finally {
      testDb.close();
    }
  });
});

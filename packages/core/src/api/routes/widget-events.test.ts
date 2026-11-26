import { describe, expect, it } from "@rstest/core";
import type { SetupStartOutcome } from "../../connections/setup/start.js";
import { type SetupStartRequest, widgetEventRoutes } from "./widget-events.js";
import { connectCardUi } from "../../connections/connect-card.js";

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

/** The route with its messages, its chats, and a caller. */
function setup(
  rows: Record<string, Row>,
  caller: string | null = "guardian",
  appReply: unknown = { ok: true },
  connections: unknown[] = [],
  deviceConnections: unknown[] = [],
  storedDevice: string | null = null,
  setupState: SetupStartOutcome = {
    status: "started",
    started: {
      cid: "cid-1",
      reattached: false,
      state: { status: "awaiting-redirect", url: "https://cloud.example/authorize?state=s1" },
    },
  },
) {
  const setups: SetupStartRequest[] = [];
  const forwarded: {
    url: string;
    body: unknown;
    cookie: string | null;
    device?: string | null;
  }[] = [];
  const app = widgetEventRoutes({
    webchatRepo: {
      askingDeviceOf: async () => storedDevice,
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
    callerEmail: async () => (caller?.startsWith("visitor:") ? "member@example.test" : undefined),
    startSetup: async (request) => {
      setups.push(request);
      return setupState;
    },
    forward: async (request) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/api/connections") {
        return Response.json({ connections });
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/api/device-connections") {
        return Response.json({ connections: deviceConnections });
      }
      forwarded.push({
        url: new URL(request.url).pathname,
        body: await request.json(),
        cookie: request.headers.get("cookie"),
        ...(request.headers.has("x-rome-device")
          ? { device: request.headers.get("x-rome-device") }
          : {}),
      });
      return Response.json(
        new URL(request.url).pathname.startsWith("/api/apps/") ? appReply : { ok: true },
      );
    },
  });
  const fire = (widgetId: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/chat/widgets/${widgetId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "rome_session=x",
        // As a browser on this instance's own page sends it.
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { fire, forwarded, setups };
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
        askingDeviceOf: async () => null,
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

  it("is any member's to fire, in a Concierge chat someone else owns", async () => {
    const { fire, forwarded } = setup(
      { m1: { chatId: "private", content: [mealWidget("w1", "meals", "water")] } },
      "visitor:someone",
    );
    expect((await fire("m1", { name: "water" })).status).toBe(200);
    expect(forwarded.map((f) => f.url)).toEqual(["/api/apps/meals/water"]);
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
});

describe("an event on the connect card core owns", () => {
  const connectCard = {
    type: "pending_interaction",
    toolUseId: "k1",
    appId: "core",
    render: {
      kind: "inline",
      componentId: "connect-card",
      ui: {
        components: [
          { id: "root", component: "Column", children: ["connect", "check", "dismiss"] },
          button("connect", "connect", { kind: "github" }),
          button("check", "check", { kind: "github" }),
          button("dismiss", "dismiss", { kind: "github" }),
        ],
      },
    },
  };
  const github = (state: string | null, connect: unknown, id: string | null = null) => [
    { id, connectionKind: "github", grants: { user: "unauthorized" }, state, connect },
  ];
  const link = {
    url: "/api/oauth/github/start",
    available: true,
    unavailableReason: null,
  };
  const redirect = (url: string): SetupStartOutcome => ({
    status: "started",
    started: { cid: "cid-1", reattached: false, state: { status: "awaiting-redirect", url } },
  });

  it("starts the setup the Connections page's Connect starts, and opens its authorization page", async () => {
    const { fire, forwarded, setups } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github(null, link),
    );
    const res = await fire("m", { name: "connect", context: { kind: "github" } });
    expect(await res.json()).toEqual({ open: "https://cloud.example/authorize?state=s1" });
    expect(setups).toEqual([{ idOrKind: "github", grant: "user", force: false }]);
    expect(forwarded).toEqual([]);
  });

  it("starts no setup for a Connect from another site, as the setup route refuses one", async () => {
    const { fire, setups } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github(null, link),
    );
    const res = await fire(
      "m",
      { name: "connect", context: { kind: "github" } },
      { "sec-fetch-site": "same-site" },
    );
    expect(res.status).toBe(403);
    expect(setups).toEqual([]);
  });

  it("starts afresh into a broken connection, as the page's Reconnect does", async () => {
    const { fire, setups } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github("broken", link, "conn-1"),
    );
    await fire("m", { name: "connect", context: { kind: "github" } });
    expect(setups).toEqual([{ idOrKind: "conn-1", grant: "user", force: true }]);
  });

  it("opens Shopify's install page, as the page does, and starts no setup", async () => {
    const install = {
      url: "https://apps.shopify.com/rome",
      available: true,
      unavailableReason: null,
    };
    const { fire, setups } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      [
        {
          id: null,
          connectionKind: "shopify",
          grants: { store: "unauthorized" },
          state: null,
          connect: install,
        },
      ],
    );
    const res = await fire("m", { name: "connect", context: { kind: "shopify" } });
    expect(await res.json()).toEqual({ open: "https://apps.shopify.com/rome" });
    expect(setups).toEqual([]);
  });

  it("refuses Connect with the setup's reason when it does not start", async () => {
    const { fire } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github(null, link),
      [],
      null,
      { status: "refused", code: 404, error: "No setup for this grant." },
    );
    const res = await fire("m", { name: "connect", context: { kind: "github" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No setup for this grant." });
  });

  it("turns a link to a dashboard page into a link on the caller's origin", async () => {
    const { fire } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github(null, link),
      [],
      null,
      redirect("/settings/connections"),
    );
    const res = await fire("m", { name: "connect", context: { kind: "github" } });
    expect(await res.json()).toEqual({ open: "http://localhost/settings/connections" });
  });

  it("joins a dashboard page to the address the guardian reached Rome at, behind a proxy", async () => {
    const { fire } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github(null, link),
      [],
      null,
      redirect("/settings/connections"),
    );
    const res = await fire(
      "m",
      { name: "connect", context: { kind: "github" } },
      { "x-forwarded-host": "rome.example.com", "x-forwarded-proto": "https" },
    );
    expect(await res.json()).toEqual({ open: "https://rome.example.com/settings/connections" });
  });

  it("refuses Connect with the reason when the kind can't be connected here", async () => {
    const { fire } = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github(null, { url: null, available: false, unavailableReason: "Rome Cloud is not set up." }),
    );
    const res = await fire("m", { name: "connect", context: { kind: "github" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Rome Cloud is not set up." });
  });

  it("answers the agent on Check only once the connection is working", async () => {
    const notYet = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github("broken", link),
    );
    expect(
      await (await notYet.fire("m", { name: "check", context: { kind: "github" } })).json(),
    ).toEqual({ error: "github isn't connected yet. Finish authorizing, then try again." });
    expect(notYet.forwarded).toEqual([]);

    const working = setup(
      { m: { chatId: "c1", content: [connectCard] } },
      "guardian",
      undefined,
      github("working", link),
    );
    const res = await working.fire("m", { name: "check", context: { kind: "github" } });
    expect(await res.json()).toMatchObject({ answered: true });
    expect(working.forwarded[0]?.body).toMatchObject({
      parts: [{ toolUseId: "k1", output: { kind: "github", status: "connected" } }],
    });
  });

  it("answers that the guardian declined on Dismiss", async () => {
    const { fire, forwarded } = setup({ m: { chatId: "c1", content: [connectCard] } });
    await fire("m", { name: "dismiss", context: { kind: "github" } });
    expect(forwarded[0]?.body).toMatchObject({
      parts: [{ output: { kind: "github", dismissed: true } }],
    });
  });
});

describe("an event on the connect card for a device kind", () => {
  const context = { kind: "apple_health", device: true };
  const deviceCard = {
    type: "pending_interaction",
    toolUseId: "k2",
    appId: "core",
    render: {
      kind: "inline",
      componentId: "connect-card",
      props: { kind: "apple_health", label: "Apple Health", device: true },
      // The card core draws, which has no button for check: the device's app
      // sends it once its flow ends.
      ui: connectCardUi("apple_health", "Apple Health", true),
    },
  };
  /** A Health row as `GET /api/device-connections` lists it, reported `ago` ms before now. */
  const row = (state: string, deviceId = "dev-1", ago = 0) => ({
    id: `${deviceId}:apple_health`,
    device: { id: deviceId, name: null, platform: "ios" },
    capability: "apple_health",
    title: "Apple Health",
    state,
    operations: [],
    lastSeenAt: new Date(Date.now() - ago).toISOString(),
  });
  const health = (state: string) => [row(state)];
  const card = (rows: unknown[]) =>
    setup({ m: { chatId: "c1", content: [deviceCard] } }, "guardian", undefined, [], rows);

  it("opens the device's page on Connect, on the caller's origin", async () => {
    const { fire, forwarded } = card(health("off"));
    const res = await fire("m", { name: "connect", context });
    expect(await res.json()).toEqual({ open: "http://localhost/connections/device/apple_health" });
    expect(forwarded).toEqual([]);
  });

  it("answers at once on Connect when a device's connection already works", async () => {
    const { fire, forwarded } = card(health("working"));
    await fire("m", { name: "connect", context });
    expect(forwarded[0]?.body).toMatchObject({
      parts: [{ toolUseId: "k2", output: { kind: "apple_health", status: "connected" } }],
    });
  });

  it("answers the agent on Check only once the device reports it working", async () => {
    const notYet = card(health("off"));
    const refused = await notYet.fire("m", { name: "check", context });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Apple Health isn't connected yet. Connect it on your device, then try again.",
    });
    expect(notYet.forwarded).toEqual([]);

    const working = card(health("working"));
    expect(await (await working.fire("m", { name: "check", context })).json()).toMatchObject({
      answered: true,
    });
    expect(working.forwarded[0]?.body).toMatchObject({
      parts: [{ output: { kind: "apple_health", status: "connected" } }],
    });
  });

  it("reads only the asking device's connection for a card raised for it", async () => {
    const forAsking = {
      ...deviceCard,
      render: {
        ...deviceCard.render,
        props: { ...deviceCard.render.props, deviceId: "dev-asking" },
      },
    };
    // The guardian's own install has Health off; another install reports it working.
    const rows = [row("off", "dev-asking"), row("working", "dev-other")];
    const off = setup(
      { m: { chatId: "c1", content: [forAsking] } },
      "guardian",
      undefined,
      [],
      rows,
    );
    expect(await (await off.fire("m", { name: "connect", context })).json()).toEqual({
      open: "http://localhost/connections/device/apple_health",
    });
    expect((await off.fire("m", { name: "check", context })).status).toBe(409);
    expect(off.forwarded).toEqual([]);

    const on = setup(
      { m: { chatId: "c1", content: [forAsking] } },
      "guardian",
      undefined,
      [],
      [{ ...rows[0], state: "working" }, rows[1]],
    );
    await on.fire("m", { name: "check", context });
    expect(on.forwarded[0]?.body).toMatchObject({
      parts: [{ output: { kind: "apple_health", status: "connected" } }],
    });
  });

  it("starts the turn an answer makes on the device: the caller's, else the card's, else the chat's", async () => {
    const forAsking = {
      ...deviceCard,
      render: { ...deviceCard.render, props: { ...deviceCard.render.props, deviceId: "dev-card" } },
    };
    const rows = [row("working", "dev-card")];
    const answerFrom = async (
      content: unknown,
      headers: Record<string, string>,
      storedDevice: string | null,
    ) => {
      const { fire, forwarded } = setup(
        { m: { chatId: "c1", content: [content] } },
        "guardian",
        undefined,
        [],
        rows,
        storedDevice,
      );
      await fire("m", { name: "check", context }, headers);
      return forwarded[0]?.device;
    };
    // Pressed on the phone, which names itself.
    expect(await answerFrom(forAsking, { "x-rome-device": "dev-phone" }, "dev-chat")).toBe(
      "dev-phone",
    );
    // Pressed where no device is named: the device the card was raised for.
    expect(await answerFrom(forAsking, {}, "dev-chat")).toBe("dev-card");
    // A card raised for no device: the device the chat was last handed work from.
    expect(await answerFrom(deviceCard, {}, "dev-chat")).toBe("dev-chat");
    expect(await answerFrom(deviceCard, {}, null)).toBeUndefined();
  });

  it("treats a device silent for 7 days as not connected, as the live read does", async () => {
    const stale = card([row("working", "dev-old", 8 * 24 * 60 * 60 * 1000)]);
    expect(await (await stale.fire("m", { name: "connect", context })).json()).toEqual({
      open: "http://localhost/connections/device/apple_health",
    });
    expect((await stale.fire("m", { name: "check", context })).status).toBe(409);
    expect(stale.forwarded).toEqual([]);
  });

  it("takes check with no button for it only on core's own card", async () => {
    const appCard = { ...deviceCard, appId: "connector" };
    const { fire } = setup(
      { m: { chatId: "c1", content: [appCard] } },
      "guardian",
      undefined,
      [],
      health("working"),
    );
    expect((await fire("m", { name: "check", context })).status).toBe(400);
  });

  it("reads the card as a device's from what core stored, whatever context the client sends", async () => {
    const working = card(health("working"));
    await working.fire("m", { name: "check", context: { kind: "apple_health" } });
    expect(working.forwarded[0]?.body).toMatchObject({
      parts: [{ output: { kind: "apple_health", status: "connected" } }],
    });
    const off = card(health("off"));
    const res = await off.fire("m", { name: "connect", context: {} });
    expect(await res.json()).toEqual({ open: "http://localhost/connections/device/apple_health" });
  });
});

describe("an event on the share-location card core owns", () => {
  const locationCard = {
    type: "pending_interaction",
    toolUseId: "l1",
    appId: "core",
    render: {
      kind: "inline",
      componentId: "location-card",
      builtin: true,
      ui: {
        components: [
          { id: "root", component: "Column", children: ["decline", "share"] },
          button("decline", "decline"),
          button("share", "share-location"),
        ],
      },
    },
  };
  const position = {
    latitude: 31.23,
    longitude: 121.47,
    accuracy: 18.4,
    timestamp: 1_800_000_000_000,
  };

  it("answers the agent with the position the client read on Share", async () => {
    const theirs = setup({ m: { chatId: "private", content: [locationCard] } }, "visitor:v");
    expect((await theirs.fire("m", { name: "share-location", context: position })).status).toBe(
      404,
    );
    expect(theirs.forwarded).toEqual([]);

    const { fire, forwarded } = setup({ m: { chatId: "c1", content: [locationCard] } });
    const res = await fire("m", { name: "share-location", context: position });
    expect(await res.json()).toMatchObject({ answered: true });
    expect(forwarded[0]?.body).toMatchObject({
      parts: [
        {
          toolUseId: "l1",
          messageId: "m",
          output: {
            status: "shared",
            latitude: 31.23,
            longitude: 121.47,
            accuracyMeters: 18,
            fixedAt: new Date(1_800_000_000_000).toISOString(),
          },
        },
      ],
    });
  });

  it("refuses a Share that carries no position, and leaves the card waiting", async () => {
    const { fire, forwarded } = setup({ m: { chatId: "c1", content: [locationCard] } });
    const res = await fire("m", {
      name: "share-location",
      context: { latitude: 91, longitude: 0 },
    });
    expect(res.status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it("answers that the guardian declined on Not now", async () => {
    const { fire, forwarded } = setup({ m: { chatId: "c1", content: [locationCard] } });
    await fire("m", { name: "decline" });
    expect(forwarded[0]?.body).toMatchObject({
      parts: [{ output: { status: "declined", dismissed: true } }],
    });
  });

  it("takes no answer once the card was answered or skipped by a message", async () => {
    const { fire, forwarded } = setup({
      m: { chatId: "c1", content: [locationCard] },
      n: {
        chatId: "c1",
        content: [{ type: "interaction_result", toolUseId: "l1", output: { dismissed: true } }],
      },
    });
    const res = await fire("m", { name: "share-location", context: position });
    expect(res.status).toBe(400);
    expect(forwarded).toEqual([]);
  });

  it("marks a share the client sent by itself only on a card core marked for it", async () => {
    const marked = {
      ...locationCard,
      render: { ...locationCard.render, props: { reason: "r", autoShareToken: "t" } },
    };
    const auto = setup({ m: { chatId: "c1", content: [marked] } });
    await auto.fire("m", { name: "share-location", context: { ...position, auto: true } });
    expect(
      (auto.forwarded[0]?.body as { parts: { output: Record<string, unknown> }[] }).parts[0]
        ?.output,
    ).toMatchObject({ status: "shared", auto: true });
    // An unmarked card's share says nothing of how it was sent, whatever the client claims.
    const plain = setup({ m: { chatId: "c1", content: [locationCard] } });
    await plain.fire("m", { name: "share-location", context: { ...position, auto: true } });
    expect(
      (plain.forwarded[0]?.body as { parts: { output: Record<string, unknown> }[] }).parts[0]
        ?.output,
    ).not.toHaveProperty("auto");
  });

  it("shares by itself only on the client of who asked, and records a member's share as theirs", async () => {
    const marked = {
      ...locationCard,
      render: {
        ...locationCard.render,
        props: { reason: "r", autoShareToken: "t", autoShareFor: "guardian" },
      },
    };
    const output = (s: ReturnType<typeof setup>) =>
      (s.forwarded[0]?.body as { parts: { output: Record<string, unknown> }[] }).parts[0]?.output;
    // Another viewer's client answering by itself starts nothing.
    const other = setup({ m: { chatId: "c1", content: [marked] } }, "visitor:v");
    const res = await other.fire("m", {
      name: "share-location",
      context: { ...position, auto: true },
    });
    expect(res.status).toBe(409);
    expect(other.forwarded).toEqual([]);
    // Their press is their own location.
    await other.fire("m", { name: "share-location", context: position });
    expect(output(other)).toMatchObject({ status: "shared", sharedBy: "member@example.test" });
    expect(output(other)).not.toHaveProperty("auto");
    // The asker's client still shares by itself.
    const asker = setup({ m: { chatId: "c1", content: [marked] } });
    await asker.fire("m", { name: "share-location", context: { ...position, auto: true } });
    expect(output(asker)).toMatchObject({ status: "shared", auto: true });
    expect(output(asker)).not.toHaveProperty("sharedBy");
  });

  it("lets the first of two clients answer, and refuses the other", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turns: unknown[] = [];
    const app = widgetEventRoutes({
      webchatRepo: {
        askingDeviceOf: async () => null,
        widgetMessage: async () => ({ chatId: "c1", content: JSON.stringify([locationCard]) }),
        getMessages: (async () => [
          { id: "m", role: "assistant", content: JSON.stringify([locationCard]) },
        ]) as never,
        getSession: (async (id: string) => ({ id, ownerKey: null })) as never,
      },
      callerOwner: async () => "guardian",
      forward: async (request) => {
        turns.push(await request.json());
        await held;
        return Response.json({ ok: true });
      },
    });
    const fire = (body: unknown) =>
      app.request("/chat/widgets/m/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = fire({ name: "share-location", context: position });
    // The second press lands while the first answer is on its way to the chat.
    while (turns.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await fire({ name: "decline" });
    release();
    expect((await first).status).toBe(200);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "This card was already answered" });
    expect(turns).toHaveLength(1);
  });
});

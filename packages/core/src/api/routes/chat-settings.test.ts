import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import type { ApiDeps } from "../deps.js";
import { chatSettingsRoutes } from "./chat-settings.js";

function harness(person?: SessionActor) {
  const list = rs.fn(async () => ({ items: [], nextCursor: "next" }));
  const update = rs.fn(async (input: unknown) => ({ input }));
  const reset = rs.fn(async (input: unknown) => ({ input }));
  const deps = {
    chatSettings: { list, update, reset },
  } as unknown as ApiDeps;
  const app = new Hono();
  if (person) app.use("*", (_c, next) => runWithSessionActor(person, next));
  app.route("/", chatSettingsRoutes(deps));
  return { app, list, update, reset };
}

describe("chat settings routes", () => {
  it("passes server-backed filters and pagination to the shared control", async () => {
    const { app, list } = harness();
    const response = await app.request(
      "/chat-settings?connectionId=conn-1&query=launch&cursor=next&limit=20&availability=offline&changed=true",
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      connectionId: "conn-1",
      query: "launch",
      cursor: "next",
      limit: 20,
      availability: "offline",
      changed: true,
    });
  });

  it("injects a trusted guardian actor for updates", async () => {
    const { app, update } = harness();
    const response = await app.request("/chat-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: { connectionId: "conn-1", chatId: "channel-1" },
        set: { enabled: false },
        clear: ["routing.agentName"],
        actor: { kind: "system", id: "forged" },
      }),
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      ref: { connectionId: "conn-1", chatId: "channel-1" },
      set: { enabled: false },
      clear: ["routing.agentName"],
      actor: { kind: "guardian", id: "dashboard" },
    });
  });

  it.each<{ kind: "guardian" | "member"; person: SessionActor }>([
    { kind: "guardian", person: { kind: "guardian", userId: "admin", via: "cookie" } },
    { kind: "member", person: { kind: "visitor", accountId: "ada", email: "ada@example.com" } },
  ])("records a $kind's update and reset as a $kind's", async ({ kind, person }) => {
    const { app, update, reset } = harness(person);
    const send = (path: string, method: string) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { connectionId: "conn-1", chatId: "channel-1" } }),
      });
    expect((await send("/chat-settings", "PATCH")).status).toBe(200);
    expect((await send("/chat-settings/reset", "POST")).status).toBe(200);
    const actor = { kind, id: "dashboard" };
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ actor }));
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  it("resets through the same control and rejects malformed refs", async () => {
    const { app, reset } = harness();
    const response = await app.request("/chat-settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: { connectionId: "conn-1", chatId: "channel-1" } }),
    });
    expect(response.status).toBe(200);
    expect(reset).toHaveBeenCalledWith({
      ref: { connectionId: "conn-1", chatId: "channel-1" },
      actor: { kind: "guardian", id: "dashboard" },
    });

    const invalid = await app.request("/chat-settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: { chatId: "channel-1" } }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "ref.connectionId is required" });
  });

  it("answers on the path a dashboard from before the chat rename calls", async () => {
    const { app, list, reset } = harness();

    expect((await app.request("/conversation-settings")).status).toBe(200);
    const response = await app.request("/conversation-settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: { connectionId: "conn-1", chatId: "channel-1" } }),
    });

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

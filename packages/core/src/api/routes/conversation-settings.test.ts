import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";
import { conversationSettingsRoutes } from "./conversation-settings.js";

function harness() {
  const list = rs.fn(async () => ({ items: [], nextCursor: "next" }));
  const update = rs.fn(async (input: unknown) => ({ input }));
  const reset = rs.fn(async (input: unknown) => ({ input }));
  const deps = {
    conversationSettings: { list, update, reset },
  } as unknown as ApiDeps;
  const app = new Hono().route("/", conversationSettingsRoutes(deps));
  return { app, list, update, reset };
}

describe("conversation settings routes", () => {
  it("passes server-backed filters and pagination to the shared control", async () => {
    const { app, list } = harness();
    const response = await app.request(
      "/conversation-settings?connectionId=conn-1&query=launch&cursor=next&limit=20&availability=offline",
    );

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      connectionId: "conn-1",
      query: "launch",
      cursor: "next",
      limit: 20,
      availability: "offline",
    });
  });

  it("injects a trusted guardian actor for updates", async () => {
    const { app, update } = harness();
    const response = await app.request("/conversation-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: { connectionId: "conn-1", conversationId: "channel-1" },
        set: { enabled: false },
        clear: ["routing.agentName"],
        actor: { kind: "system", id: "forged" },
      }),
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      ref: { connectionId: "conn-1", conversationId: "channel-1" },
      set: { enabled: false },
      clear: ["routing.agentName"],
      actor: { kind: "guardian", id: "dashboard" },
    });
  });

  it("resets through the same control and rejects malformed refs", async () => {
    const { app, reset } = harness();
    const response = await app.request("/conversation-settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: { connectionId: "conn-1", conversationId: "channel-1" } }),
    });
    expect(response.status).toBe(200);
    expect(reset).toHaveBeenCalledWith({
      ref: { connectionId: "conn-1", conversationId: "channel-1" },
      actor: { kind: "guardian", id: "dashboard" },
    });

    const invalid = await app.request("/conversation-settings/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: { conversationId: "channel-1" } }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "ref.connectionId is required" });
  });
});

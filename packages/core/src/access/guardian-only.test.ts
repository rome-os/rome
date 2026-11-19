import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { guardianOnly } from "./guardian-only.js";
import { runWithSessionActor, type SessionActor } from "./session-actor.js";

function build(actor: SessionActor): Hono {
  const app = new Hono();
  app.use("*", (_c, next) => runWithSessionActor(actor, next));
  app.use("*", guardianOnly);
  app.get("/x", (c) => c.text("in"));
  return app;
}

describe("guardianOnly", () => {
  it("lets the guardian in", async () => {
    const response = await build({ kind: "guardian", userId: "owner", via: "cookie" }).request(
      "/x",
    );
    expect(response.status).toBe(200);
  });

  it("refuses anyone but the guardian", async () => {
    for (const actor of [
      { kind: "anonymous" } as const,
      { kind: "visitor", accountId: "guest", email: "guest@example.com" } as const,
    ]) {
      expect((await build(actor).request("/x")).status).toBe(403);
    }
  });
});

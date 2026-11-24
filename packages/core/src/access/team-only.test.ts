import { describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { runWithSessionActor, type SessionActor } from "./session-actor.js";
import { teamOnly } from "./team-only.js";

function build(actor: SessionActor, allowList: DashboardAccessState): Hono {
  const app = new Hono();
  app.use("*", (_c, next) => runWithSessionActor(actor, next));
  app.use("*", teamOnly(allowList));
  app.get("/x", (c) => c.text("in"));
  return app;
}

const teammate = { kind: "visitor", accountId: "ada", email: "ada@example.com" } as const;

describe("teamOnly", () => {
  it("lets the guardian and a dashboard admin in", async () => {
    const allowList = new DashboardAccessState();
    allowList.setCloudEmailAccess(["ada@example.com"]);
    const guardian = { kind: "guardian", userId: "owner", via: "cookie" } as const;
    expect((await build(guardian, allowList).request("/x")).status).toBe(200);
    expect((await build(teammate, allowList).request("/x")).status).toBe(200);
  });

  it("refuses anyone else, and a dashboard admin once their email is removed", async () => {
    const allowList = new DashboardAccessState();
    allowList.setCloudEmailAccess(["ada@example.com"]);
    const app = build(teammate, allowList);
    expect((await build({ kind: "anonymous" }, allowList).request("/x")).status).toBe(403);
    const guest = { kind: "visitor", accountId: "guest", email: "guest@example.com" } as const;
    expect((await build(guest, allowList).request("/x")).status).toBe(403);
    allowList.setCloudEmailAccess([]);
    expect((await app.request("/x")).status).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";
import { runWithSessionActor, type SessionActor } from "../../lib/session-actor.js";
import { userActivityRoutes } from "./user-activity.js";

describe("user activity reporting", () => {
  const owner: SessionActor = {
    kind: "guardian",
    via: "cookie",
    userId: "seat",
    accountId: "owner",
  };
  let actor: SessionActor;
  let app: Hono;
  const fetchMock = rs.fn<typeof fetch>();

  beforeEach(() => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    actor = owner;
    app = new Hono();
    app.use("*", (_c, next) => runWithSessionActor(actor, next));
    app.route("/", userActivityRoutes());
    setInstanceTokenInMemory("romeinst_test");
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.test");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    rs.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    rs.useRealTimers();
    rs.unstubAllGlobals();
    rs.unstubAllEnvs();
    setInstanceTokenInMemory(null);
  });

  const report = (body = {}) =>
    app.request("/user-activity", {
      method: "POST",
      headers: { "X-Rome-Activity": "1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("derives the account from the cookie actor and throttles concurrent reports", async () => {
    const results = await Promise.all([report({ accountId: "someone-else" }), report()]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloud.test/api/instance/activity");
    expect(init?.headers).toEqual({
      Authorization: "Bearer romeinst_test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ accountId: "owner" });
    rs.advanceTimersByTime(60_000);
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each<SessionActor>([
    { kind: "anonymous" },
    { kind: "visitor", accountId: "visitor", email: "visitor@example.com" },
    { kind: "guardian", via: "loopback", userId: "seat", accountId: "owner" },
    { kind: "guardian", via: "cookie", userId: "local" },
  ])("does not attribute non-owner or machine activity (%j)", async (value) => {
    actor = value;
    expect((await report()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects simple cross-origin form posts", async () => {
    expect((await app.request("/user-activity", { method: "POST" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no cloud call without an enrolled instance", async () => {
    setInstanceTokenInMemory(null);
    expect((await report()).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolerates cloud failures without retries while idle", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await report()).status).toBe(204);
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rs.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await report();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

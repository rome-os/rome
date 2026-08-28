import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { feedbackRoutes } from "./feedback.js";
import { buildTestDeps, createTestDb, type TestDb } from "../../test/helpers.js";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";
import { FEEDBACK_BODY_MAX } from "../../lib/feedback.js";

interface RelayCall {
  url: string;
  headers: Headers;
  body: string;
}

describe("POST /api/feedback", () => {
  let testDb: TestDb;
  let app: Hono;
  const relayCalls: RelayCall[] = [];

  function stubRelay(impl: (call: RelayCall) => Response | Promise<Response>) {
    rs.stubGlobal(
      "fetch",
      rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: RelayCall = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? init.body : "",
        };
        relayCalls.push(call);
        return impl(call);
      }),
    );
  }

  beforeEach(async () => {
    testDb = createTestDb();
    const deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", feedbackRoutes(deps));
    relayCalls.length = 0;
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.test";
    setInstanceTokenInMemory("romeinst_test-token");
    stubRelay(() => new Response(JSON.stringify({ ok: true }), { status: 201 }));
  });

  afterEach(() => {
    rs.unstubAllGlobals();
    setInstanceTokenInMemory(null);
    delete process.env.PANTHEON_BASE_ORIGIN;
    testDb.close();
  });

  function submit(body: unknown) {
    return app.request("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("given valid feedback, when submitted, then it relays a versioned report to Rome Cloud with the instance token and returns 201", async () => {
    const res = await submit({ body: "the sidebar is great", client: { route: "/chat" } });

    expect(res.status).toBe(201);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0].url).toBe("https://rome-cloud.test/api/instance/feedback");
    expect(relayCalls[0].headers.get("authorization")).toBe("Bearer romeinst_test-token");

    const sent = JSON.parse(relayCalls[0].body);
    expect(sent.schemaVersion).toBe(1);
    expect(sent.body).toBe("the sidebar is great");
    expect(sent.payload.client).toEqual({ route: "/chat" });
    // Diagnostics are server-assembled, not client-supplied.
    expect(sent.payload.diagnostics).toHaveProperty("database");
    expect(sent.payload.diagnostics).toHaveProperty("build");
  });

  it("given a client that smuggles a `diagnostics` key, when submitted, then it is confined to payload.client and the trusted payload.diagnostics stays server-owned", async () => {
    await submit({ body: "hi", client: { diagnostics: { build: { sha: "evil" } } } });

    const sent = JSON.parse(relayCalls[0].body);
    // The spoof attempt is quarantined under the untrusted namespace…
    expect(sent.payload.client.diagnostics).toEqual({ build: { sha: "evil" } });
    // …and the trusted namespace is the real, server-measured bundle.
    expect(sent.payload.diagnostics).toHaveProperty("database");
    expect(sent.payload.diagnostics.build?.sha).not.toBe("evil");
  });

  it("given a top-level field outside the envelope, when submitted, then the strict schema rejects it with 400 and nothing is relayed", async () => {
    const res = await submit({ body: "hi", client: {}, diagnostics: { build: { sha: "evil" } } });

    expect(res.status).toBe(400);
    expect(relayCalls).toHaveLength(0);
  });

  it("given an empty body, when submitted, then it is rejected with 400", async () => {
    const res = await submit({ body: "   ", client: {} });

    expect(res.status).toBe(400);
    expect(relayCalls).toHaveLength(0);
  });

  it("given a body over the max length, when submitted, then it is rejected with 400", async () => {
    const res = await submit({ body: "x".repeat(FEEDBACK_BODY_MAX + 1), client: {} });

    expect(res.status).toBe(400);
    expect(relayCalls).toHaveLength(0);
  });

  it("given Rome Cloud is unreachable, when submitted, then it returns 502", async () => {
    stubRelay(() => {
      throw new Error("network down");
    });

    const res = await submit({ body: "hi", client: {} });

    expect(res.status).toBe(502);
  });

  it("given Rome Cloud rejects the report as too large, when submitted, then the upstream status is mirrored", async () => {
    stubRelay(() => new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413 }));

    const res = await submit({ body: "hi", client: {} });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("given no instance token, when submitted, then it returns 503 and nothing is relayed", async () => {
    setInstanceTokenInMemory(null);

    const res = await submit({ body: "hi", client: {} });

    expect(res.status).toBe(503);
    expect(relayCalls).toHaveLength(0);
  });
});

import { describe, expect, it, rs } from "@rstest/core";
import { FeedbackClient, type AgentFeedback, type FeedbackClientDeps } from "./feedback-client.js";
import type { DiagnosticBundle } from "./diagnostics.js";

const report: AgentFeedback = {
  category: "bug",
  subject: "system:test",
  summary: "Broken",
  details: "Expected success.",
  reporter: { kind: "agent", agentName: "main", sessionId: "s", turnId: "t", executionId: "e" },
};
const diagnostics = { database: { ok: true } } as DiagnosticBundle;
function client(overrides: Partial<FeedbackClientDeps> = {}) {
  const fetchImpl = rs.fn(
    async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 201 }),
  );
  const deps = {
    diagnostics: async () => diagnostics,
    agentReportsEnabled: async () => true,
    getToken: () => "token",
    getOrigin: () => "https://cloud.test",
    fetchImpl,
    ...overrides,
  };
  return { client: new FeedbackClient(deps), fetchImpl };
}
const guardian = { body: "Human feedback", client: { reporter: { kind: "agent" } } };

describe("FeedbackClient", () => {
  it("composes the body and confines caller context to client, provenance to diagnostics", async () => {
    const { client: c, fetchImpl } = client();
    expect(await c.send(report)).toEqual({ kind: "ok" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://cloud.test/api/instance/feedback");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      schemaVersion: 1,
      body: "Broken\n\nExpected success.",
      payload: {
        client: { category: "bug", subject: "system:test" },
        diagnostics: { ...diagnostics, reporter: report.reporter },
      },
    });
    await c.sendGuardian(guardian);
    expect(
      JSON.parse(fetchImpl.mock.calls[1][1]?.body as string).payload.diagnostics.reporter,
    ).toEqual({ kind: "guardian" });
  });

  it("reads the token and origin fresh per call without changing token storage", async () => {
    let token: string | null = "first";
    let origin: string | null = "https://first.test";
    const { client: c, fetchImpl } = client({ getToken: () => token, getOrigin: () => origin });
    await c.sendGuardian(guardian);
    token = "second";
    origin = "https://second.test";
    await c.sendGuardian(guardian);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("authorization")).toBe(
      "Bearer second",
    );
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://second.test/api/instance/feedback");
    token = null;
    expect(await c.sendGuardian(guardian)).toEqual({ kind: "no_token" });
    token = "third";
    origin = null;
    expect(await c.sendGuardian(guardian)).toEqual({ kind: "unconfigured" });
  });

  it.each([
    400, 401, 403, 413, 429, 500,
  ])("classifies HTTP %s as rejected and preserves the guardian response", async (status) => {
    const body = { error: "rejected" };
    const { client: c } = client({
      fetchImpl: rs.fn(async () => new Response(JSON.stringify(body), { status })),
    });
    expect(await c.send(report)).toEqual({ kind: "rejected", status, body });
  });

  it("preserves rejected status when upstream body is not JSON", async () => {
    const { client: c } = client({
      fetchImpl: rs.fn(async () => new Response("bad", { status: 502 })),
    });
    expect(await c.send(report)).toEqual({
      kind: "rejected",
      status: 502,
      body: { error: "relay_failed" },
    });
  });

  it("classifies network errors and suppresses retry of an ambiguous send", async () => {
    const { client: c } = client({
      fetchImpl: rs.fn(async () => {
        throw new Error("network");
      }),
    });
    expect(await c.send(report)).toEqual({ kind: "unreachable" });
    expect(await c.send(report)).toEqual({ kind: "duplicate" });
  });

  it("bounds timeout without retrying", async () => {
    const fetchImpl = rs.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { client: c } = client({ fetchImpl, timeoutMs: 5 });
    expect(await c.send(report)).toEqual({ kind: "unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("suppresses normalized category/subject/summary duplicates regardless of details", async () => {
    const { client: c } = client();
    await c.send(report);
    expect(
      await c.send({
        ...report,
        summary: "  BROKEN  ",
        subject: " SYSTEM:test ",
        details: "different",
      }),
    ).toEqual({ kind: "duplicate" });
    expect(await c.send({ ...report, category: "ux" })).toEqual({ kind: "ok" });
    expect(await c.send({ ...report, subject: "other" })).toEqual({ kind: "ok" });
  });

  it("caps 10 concurrent agent attempts, never guardian reports; expires at 24h", async () => {
    let now = 0;
    const { client: c, fetchImpl } = client({ now: () => now });
    const outcomes = await Promise.all(
      Array.from({ length: 11 }, (_, i) => c.send({ ...report, summary: String(i) })),
    );
    expect(outcomes.filter((o) => o.kind === "ok")).toHaveLength(10);
    expect(outcomes[10]).toEqual({ kind: "rate_limited" });
    for (let i = 0; i < 12; i++) expect(await c.sendGuardian(guardian)).toEqual({ kind: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(22);
    now = 24 * 60 * 60 * 1000;
    expect(await c.send({ ...report, summary: "0" })).toEqual({ kind: "ok" });
  });

  it("suppresses concurrent duplicates before dispatch", async () => {
    const { client: c, fetchImpl } = client();
    expect(await Promise.all([c.send(report), c.send(report)])).toEqual([
      { kind: "ok" },
      { kind: "duplicate" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors the current guardian setting before diagnostics or HTTP, without affecting human feedback", async () => {
    let enabled = false;
    const measure = rs.fn(async () => diagnostics);
    const { client: c, fetchImpl } = client({
      agentReportsEnabled: async () => enabled,
      diagnostics: measure,
    });
    expect(await c.send(report)).toEqual({ kind: "disabled" });
    expect(measure).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await c.sendGuardian(guardian)).toEqual({ kind: "ok" });
    enabled = true;
    expect(await c.send(report)).toEqual({ kind: "ok" });
  });
});

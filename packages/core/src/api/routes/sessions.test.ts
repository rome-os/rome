import { describe, expect, it, rs } from "@rstest/core";
import type { SessionQueries } from "./sessions.js";
import { sessionsRoutes } from "./sessions.js";

function createService(): SessionQueries {
  return {
    querySessions: rs.fn(async () => ({ marker: "query" }) as never),
    queryMetrics: rs.fn(async () => ({ marker: "metrics" }) as never),
    getSession: rs.fn(async () => null),
  };
}

describe("sessions routes", () => {
  it("validates a metrics request before calling the service", async () => {
    const service = createService();
    const response = await sessionsRoutes(service).request("/sessions/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { time: { kind: "all" }, timeZone: "not-a-time-zone" },
        projections: [
          {
            id: "trend",
            groupBy: "model",
            interval: "day",
            rankBy: "tokens",
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(service.queryMetrics).not.toHaveBeenCalled();
  });

  it("passes structured scope and multiple projections to the service", async () => {
    const service = createService();
    const body = {
      scope: {
        time: { kind: "preset", value: "7d" },
        timeZone: "Asia/Taipei",
        sessions: {
          owners: [{ kind: "app", appId: "code-review" }],
          projectPathPrefix: "/workspace/rome",
        },
        runs: {
          models: [{ kind: "named", provider: "openai", name: "gpt-5.4" }],
          outcomes: ["completed"],
        },
      },
      projections: [
        {
          id: "trend",
          groupBy: "model",
          interval: "auto",
          rankBy: "tokens",
          limit: 6,
          includeOther: true,
        },
        {
          id: "breakdown",
          groupBy: "app",
          interval: "none",
          rankBy: "runs",
        },
      ],
    };
    const response = await sessionsRoutes(service).request("/sessions/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marker: "metrics" });
    expect(service.queryMetrics).toHaveBeenCalledWith(body);
  });

  it("rejects duplicate projection ids", async () => {
    const service = createService();
    const response = await sessionsRoutes(service).request("/sessions/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { time: { kind: "all" }, timeZone: "UTC" },
        projections: [
          { id: "same", groupBy: "model", interval: "day", rankBy: "tokens" },
          { id: "same", groupBy: "app", interval: "none", rankBy: "runs" },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(service.queryMetrics).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown session detail", async () => {
    const service = createService();
    const response = await sessionsRoutes(service).request("/sessions/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(service.getSession).toHaveBeenCalledWith("missing");
  });
});

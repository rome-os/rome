import { describe, expect, it, rs } from "@rstest/core";
import { DevUrlRuntime, resolveDevDashboardUrl } from "./dev-url";

describe("resolveDevDashboardUrl", () => {
  it("is ignored by a packaged app", () => {
    expect(resolveDevDashboardUrl(true, "https://dev.example.com")).toBeNull();
  });

  it("is off when unset or blank", () => {
    expect(resolveDevDashboardUrl(false, undefined)).toBeNull();
    expect(resolveDevDashboardUrl(false, "  ")).toBeNull();
  });

  it("keeps only the origin", () => {
    expect(resolveDevDashboardUrl(false, " https://a-b.trycloudflare.com/chat?x=1 ")).toBe(
      "https://a-b.trycloudflare.com",
    );
    expect(resolveDevDashboardUrl(false, "http://main.rome.localhost:3000")).toBe(
      "http://main.rome.localhost:3000",
    );
  });

  it("throws on a value it cannot open", () => {
    expect(() => resolveDevDashboardUrl(false, "main.rome.localhost:3000")).toThrow(
      /ROME_DESKTOP_DASHBOARD_URL/,
    );
    expect(() => resolveDevDashboardUrl(false, "not a url")).toThrow(/ROME_DESKTOP_DASHBOARD_URL/);
  });
});

describe("DevUrlRuntime", () => {
  const origin = "https://a-b.trycloudflare.com";

  it("is ready at the URL from the start", async () => {
    const runtime = new DevUrlRuntime(origin, { openLogs: async () => {} });
    expect(runtime.isReady()).toBe(true);
    expect(runtime.getDashboardUrl()).toBe(origin);
    expect(runtime.getStatus()).toMatchObject({ phase: "ready", provider: "remote" });
    expect(await runtime.isServing()).toBe(true);
  });

  it("shows a failed load, and retry makes it ready again", async () => {
    const runtime = new DevUrlRuntime(origin, { openLogs: async () => {} });
    const phases: string[] = [];
    runtime.on("status", (status) => phases.push(status.phase));

    runtime.reportLoadFailure("net::ERR_NAME_NOT_RESOLVED");
    expect(runtime.getStatus()).toMatchObject({
      phase: "failed",
      primaryAction: "retry",
      lastError: "net::ERR_NAME_NOT_RESOLVED",
    });

    await runtime.ensureReady();
    expect(runtime.isReady()).toBe(true);
    expect(phases).toEqual(["failed", "ready"]);
  });

  it("opens the debug log", async () => {
    const openLogs = rs.fn(async () => {});
    await new DevUrlRuntime(origin, { openLogs }).openLogs();
    expect(openLogs).toHaveBeenCalled();
  });
});

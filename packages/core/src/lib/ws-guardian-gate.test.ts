import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { guardianAuth } from "../db/schema.js";
import { createTestDb } from "../test/helpers.js";
import { createSession, createVisitorSession } from "./auth.js";
import { DashboardAccessState } from "./dashboard-access-state.js";
import { gateGuardianUpgrade, gateUpgrade } from "./ws-guardian-gate.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

beforeAll(async () => {
  await testDb.db.insert(guardianAuth).values({
    id: "auth-1",
    userId: "guardian-1",
    passwordHash: "irrelevant",
    createdAt: new Date(),
  });
});

function request(headers: Record<string, string> = {}, peerAddress = "127.0.0.1") {
  return {
    url: "/desktop-proxy/websockify",
    headers: { host: "127.0.0.1:4141", ...headers },
    socket: { remoteAddress: peerAddress },
  } as unknown as IncomingMessage;
}

function captureSocket() {
  let response = "";
  const socket = {
    destroyed: false,
    end(data: string) {
      response = data;
    },
  } as unknown as Duplex;
  return { socket, response: () => response };
}

describe("gateGuardianUpgrade", () => {
  it("rejects a proxied anonymous request before upgrading", async () => {
    const { socket, response } = captureSocket();
    expect(
      await gateGuardianUpgrade(request({ "x-forwarded-for": "203.0.113.1" }), socket, testDb.db),
    ).toBe(false);
    expect(response()).toContain("HTTP/1.1 401 Unauthorized");
  });

  it("accepts a same-origin guardian cookie through a reverse proxy", async () => {
    const { socket, response } = captureSocket();
    const req = request({
      cookie: `rome_session=${createSession("guardian-1")}`,
      origin: "https://rome.example",
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "https",
    });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(true);
    expect(response()).toBe("");
  });

  it("rejects a guardian cookie from another origin on the same site", async () => {
    const { socket, response } = captureSocket();
    const req = request({
      cookie: `rome_session=${createSession("guardian-1")}`,
      origin: "https://other.rome.example",
      "sec-fetch-site": "same-site",
      "x-forwarded-for": "203.0.113.1",
      "x-forwarded-host": "rome.example",
      "x-forwarded-proto": "https",
    });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(false);
    expect(response()).toContain("HTTP/1.1 403 Forbidden");
  });

  it("rejects a guardian cookie without origin evidence", async () => {
    const { socket, response } = captureSocket();
    const req = request({
      cookie: `rome_session=${createSession("guardian-1")}`,
      "x-forwarded-for": "203.0.113.1",
    });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(false);
    expect(response()).toContain("HTTP/1.1 403 Forbidden");
  });

  it("does not treat a visitor cookie as a guardian cookie", async () => {
    const { socket, response } = captureSocket();
    const req = request({
      cookie: `rome_session=${createVisitorSession("visitor-1", "visitor@example.com")}`,
      origin: "https://rome.example",
      "x-forwarded-for": "203.0.113.1",
    });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(false);
    expect(response()).toContain("HTTP/1.1 401 Unauthorized");
  });

  it("accepts a direct loopback caller without a cookie or Origin", async () => {
    const { socket, response } = captureSocket();
    expect(await gateGuardianUpgrade(request(), socket, testDb.db)).toBe(true);
    expect(response()).toBe("");
  });

  it("rejects a direct loopback caller whose Origin is another site", async () => {
    const { socket, response } = captureSocket();
    const req = request({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(false);
    expect(response()).toContain("HTTP/1.1 403 Forbidden");
  });

  it("accepts a direct loopback caller from the dashboard's own origin", async () => {
    const { socket, response } = captureSocket();
    const req = request({ origin: "http://127.0.0.1:4141" });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(true);
    expect(response()).toBe("");
  });

  it("rejects a direct loopback caller whose page sits on a DNS-rebound name", async () => {
    const { socket, response } = captureSocket();
    const req = request({
      host: "evil.example:4141",
      origin: "http://evil.example:4141",
      "sec-fetch-site": "same-origin",
    });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(false);
    expect(response()).toContain("HTTP/1.1 403 Forbidden");
  });

  it("admits an allow-listed dashboard visitor only when dashboard access is passed", async () => {
    const dashboardAccess = new DashboardAccessState();
    dashboardAccess.setCloudEmailAccess(["visitor@example.com"]);
    const visitor = (email: string, origin = "https://rome.example") =>
      request({
        cookie: `rome_visitor=${createVisitorSession("account-1", email)}`,
        origin,
        "x-forwarded-for": "203.0.113.1",
        "x-forwarded-host": "rome.example",
        "x-forwarded-proto": "https",
      });

    const allowed = captureSocket();
    expect(
      await gateUpgrade(visitor("visitor@example.com"), allowed.socket, testDb.db, dashboardAccess),
    ).toEqual({ kind: "dashboard-visitor", email: "visitor@example.com" });
    expect(allowed.response()).toBe("");

    const guardianOnly = captureSocket();
    expect(await gateUpgrade(visitor("visitor@example.com"), guardianOnly.socket, testDb.db)).toBe(
      null,
    );
    expect(guardianOnly.response()).toContain("HTTP/1.1 401 Unauthorized");

    const stranger = captureSocket();
    expect(
      await gateUpgrade(
        visitor("stranger@example.com"),
        stranger.socket,
        testDb.db,
        dashboardAccess,
      ),
    ).toBe(null);
    expect(stranger.response()).toContain("HTTP/1.1 401 Unauthorized");

    const crossOrigin = captureSocket();
    expect(
      await gateUpgrade(
        visitor("visitor@example.com", "https://evil.example"),
        crossOrigin.socket,
        testDb.db,
        dashboardAccess,
      ),
    ).toBe(null);
    expect(crossOrigin.response()).toContain("HTTP/1.1 403 Forbidden");
  });

  it("rejects a proxied loopback caller without a cookie", async () => {
    const { socket, response } = captureSocket();
    const req = request({ "x-forwarded-for": "203.0.113.1" });
    expect(await gateGuardianUpgrade(req, socket, testDb.db)).toBe(false);
    expect(response()).toContain("HTTP/1.1 401 Unauthorized");
  });
});

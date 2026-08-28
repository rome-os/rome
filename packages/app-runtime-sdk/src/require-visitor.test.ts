import { describe, expect, it } from "@rstest/core";
import {
  requireVisitor,
  visitorAuthRequired,
  type RomeAppApiRequest,
  type RomeAppCaller,
} from "./index.js";

function makeRequest(caller: RomeAppCaller | undefined): RomeAppApiRequest {
  return {
    method: "POST",
    path: ["commissions"],
    headers: {},
    query: new URLSearchParams(),
    // Cast: simulates hosts older than the request.caller contract, which
    // omit the field entirely — requireVisitor must degrade to anonymous.
    caller: caller as RomeAppCaller,
  };
}

const visitor: RomeAppCaller = { kind: "visitor", accountId: "acc_1", email: "dana@example.com" };
const guardian: RomeAppCaller = { kind: "guardian", userId: "u_1", via: "cookie" };

describe("requireVisitor", () => {
  it("passes a visitor through with the narrowed caller", () => {
    const result = requireVisitor(makeRequest(visitor));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.caller).toEqual(visitor);
  });

  it("passes the guardian by default (favors still settle host-side)", () => {
    const result = requireVisitor(makeRequest(guardian));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.caller).toEqual(guardian);
  });

  it("rejects the guardian when allowGuardian is false", async () => {
    const result = requireVisitor(makeRequest(guardian), { allowGuardian: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toMatchObject({ error: "visitor_auth_required" });
    }
  });

  it("rejects anonymous callers with the wire-stable 401 body", async () => {
    const result = requireVisitor(makeRequest({ kind: "anonymous" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({
        error: "visitor_auth_required",
        message: "Sign in with Rome Cloud to continue.",
      });
    }
  });

  it("treats a missing caller (pre-contract host) as anonymous", () => {
    const result = requireVisitor(makeRequest(undefined));
    expect(result.ok).toBe(false);
  });

  it("carries a custom message", async () => {
    const result = requireVisitor(makeRequest({ kind: "anonymous" }), {
      message: "Sign in to Rome Cloud to commission a haiku.",
    });
    if (!result.ok) {
      expect(await result.response.json()).toMatchObject({
        message: "Sign in to Rome Cloud to commission a haiku.",
      });
    }
    expect(result.ok).toBe(false);
  });
});

describe("visitorAuthRequired", () => {
  it("builds the standalone 401 for late failure paths (favors)", async () => {
    const res = visitorAuthRequired("Sign in to pay with favors.");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "visitor_auth_required",
      message: "Sign in to pay with favors.",
    });
  });
});

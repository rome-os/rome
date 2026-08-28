import { describe, expect, it } from "@rstest/core";
import { isAppApiPathNoAuth } from "./no-auth.js";

describe("isAppApiPathNoAuth", () => {
  it("returns false when noAuth is false", () => {
    expect(isAppApiPathNoAuth(false, "/anything")).toBe(false);
  });

  it("returns false when noAuth is an empty array", () => {
    expect(isAppApiPathNoAuth([], "/anything")).toBe(false);
  });

  it("returns true for any sub-path when noAuth is true", () => {
    expect(isAppApiPathNoAuth(true, "/")).toBe(true);
    expect(isAppApiPathNoAuth(true, "/foo")).toBe(true);
    expect(isAppApiPathNoAuth(true, "/deeply/nested/path")).toBe(true);
  });

  it("matches an exact entry", () => {
    expect(isAppApiPathNoAuth(["/webhook"], "/webhook")).toBe(true);
    expect(isAppApiPathNoAuth(["/webhook"], "/webhook/other")).toBe(false);
    expect(isAppApiPathNoAuth(["/webhook"], "/other")).toBe(false);
  });

  it("matches an entry with a trailing slash by normalizing", () => {
    expect(isAppApiPathNoAuth(["/webhook/"], "/webhook")).toBe(true);
  });

  it("matches a prefix when the entry ends with /*", () => {
    const noAuth = ["/webhooks/*"];
    expect(isAppApiPathNoAuth(noAuth, "/webhooks")).toBe(true);
    expect(isAppApiPathNoAuth(noAuth, "/webhooks/stripe")).toBe(true);
    expect(isAppApiPathNoAuth(noAuth, "/webhooks/stripe/event")).toBe(true);
    expect(isAppApiPathNoAuth(noAuth, "/webhooksy")).toBe(false);
    expect(isAppApiPathNoAuth(noAuth, "/other")).toBe(false);
  });

  it("treats `/*` or `*` as a wildcard for the whole API", () => {
    expect(isAppApiPathNoAuth(["/*"], "/foo")).toBe(true);
    expect(isAppApiPathNoAuth(["*"], "/foo")).toBe(true);
    expect(isAppApiPathNoAuth(["/*"], "/")).toBe(true);
  });

  it("auto-prefixes entries that are missing the leading slash", () => {
    expect(isAppApiPathNoAuth(["webhook"], "/webhook")).toBe(true);
    expect(isAppApiPathNoAuth(["webhooks/*"], "/webhooks/stripe")).toBe(true);
  });

  it("supports multiple entries", () => {
    const noAuth = ["/health", "/webhooks/*"];
    expect(isAppApiPathNoAuth(noAuth, "/health")).toBe(true);
    expect(isAppApiPathNoAuth(noAuth, "/webhooks/stripe")).toBe(true);
    expect(isAppApiPathNoAuth(noAuth, "/admin")).toBe(false);
  });

  it("normalizes trailing slashes on the request path", () => {
    expect(isAppApiPathNoAuth(["/webhook"], "/webhook/")).toBe(true);
    expect(isAppApiPathNoAuth(["/webhooks/*"], "/webhooks/")).toBe(true);
  });

  it("treats an empty subPath as `/`", () => {
    expect(isAppApiPathNoAuth(["/"], "")).toBe(true);
    expect(isAppApiPathNoAuth(true, "")).toBe(true);
  });
});

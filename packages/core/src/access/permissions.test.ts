import { describe, expect, it } from "@rstest/core";
import { decide, GUARDIAN_ONLY, Permissions, type Permission } from "./permissions.js";

const listed: Permission = { anyoneWithLink: false, listedEmails: new Set(["ada@example.com"]) };
const linkPublic: Permission = { anyoneWithLink: true, listedEmails: new Set() };

describe("decide", () => {
  it("lets anyone in when anyone with the link may open it", () => {
    expect(decide(linkPublic, { kind: "anonymous" })).toBe("allowed");
  });

  it("always lets the guardian in", () => {
    expect(decide(GUARDIAN_ONLY, { kind: "guardian" })).toBe("allowed");
    expect(decide(listed, { kind: "guardian" })).toBe("allowed");
  });

  it("leaves a guardian-only thing to the guardian's session", () => {
    expect(decide(GUARDIAN_ONLY, { kind: "anonymous" })).toBe("guardian-only");
    expect(decide(GUARDIAN_ONLY, { kind: "visitor", email: "ada@example.com" })).toBe(
      "guardian-only",
    );
  });

  it("asks someone not signed in to sign in when emails are listed", () => {
    expect(decide(listed, { kind: "anonymous" })).toBe("sign-in-required");
  });

  it("lets a listed visitor in, whatever the case of their email", () => {
    expect(decide(listed, { kind: "visitor", email: "Ada@Example.com" })).toBe("allowed");
  });

  it("forbids a visitor who is not listed", () => {
    expect(decide(listed, { kind: "visitor", email: "bob@example.com" })).toBe("forbidden");
  });
});

describe("Permissions", () => {
  it("treats an unknown id as guardian-only", () => {
    expect(new Permissions().get("x")).toEqual(GUARDIAN_ONLY);
  });

  it("replace swaps the whole table and copies it", () => {
    const permissions = new Permissions();
    const byId = new Map([["a", linkPublic]]);
    permissions.replace(byId);
    byId.set("b", listed);
    expect(permissions.get("a")).toBe(linkPublic);
    expect(permissions.get("b")).toEqual(GUARDIAN_ONLY);

    permissions.replace(new Map([["b", listed]]));
    expect(permissions.get("a")).toEqual(GUARDIAN_ONLY);
    expect(permissions.get("b")).toBe(listed);
  });
});

import { describe, expect, it } from "@rstest/core";
import {
  isCoreMainAgentId,
  claimLegacyArtifactName,
  claimLegacyArtifactNames,
  createEmptyLegacyArtifactBindings,
  formatArtifactId,
  isCanonicalArtifactId,
  parseLegacyArtifactBindings,
  resolveArtifactId,
} from "./artifact-id.js";

describe("artifact IDs", () => {
  it("retains a scoped app id as the complete artifact namespace", () => {
    const id = formatArtifactId("@foo/bar", "baz");
    expect(id).toBe("@foo/bar:baz");
    expect(isCanonicalArtifactId(id)).toBe(true);
  });

  it("rejects the reserved self namespace", () => {
    expect(() =>
      resolveArtifactId({
        kind: "action",
        value: "self:review",
        legacyBindings: createEmptyLegacyArtifactBindings(),
      }),
    ).toThrow(/Invalid action artifact ID/);
  });

  it("resolves a bare legacy name only through its stable binding", () => {
    const bindings = createEmptyLegacyArtifactBindings();
    const id = formatArtifactId("legacy-app", "foo");
    expect(claimLegacyArtifactName(bindings, "action", "foo", id)).toEqual({ claimed: true });
    expect(resolveArtifactId({ kind: "action", value: "foo", legacyBindings: bindings })).toBe(id);

    const conflict = formatArtifactId("new-app", "foo");
    expect(claimLegacyArtifactName(bindings, "action", "foo", conflict)).toEqual({
      claimed: false,
      conflict: id,
    });
    expect(bindings.action.foo).toBe(id);
  });

  it("claims the free bare names and reports only the held one", () => {
    const bindings = createEmptyLegacyArtifactBindings();
    const holder = formatArtifactId("app-a", "app_a_run");
    bindings.action.run = holder;
    const id = formatArtifactId("app-b", "app_b_run");

    expect(claimLegacyArtifactNames(bindings, "action", ["app_b_run", "run", "go"], id)).toEqual({
      claimed: true,
      conflicts: [{ legacyName: "run", artifactId: holder }],
    });
    expect(bindings.action).toEqual({ run: holder, app_b_run: id, go: id });
  });

  it("does not guess an owner for an unknown bare name", () => {
    expect(() =>
      resolveArtifactId({
        kind: "skill",
        value: "unknown",
        legacyBindings: createEmptyLegacyArtifactBindings(),
      }),
    ).toThrow(/Unknown legacy skill name/);
  });

  it("drops malformed persisted bindings", () => {
    expect(
      parseLegacyArtifactBindings({
        version: 1,
        action: { ok: "demo:ok", invalid: "not-qualified", "bad:name": "demo:bad" },
      }).action,
    ).toEqual({ ok: "demo:ok" });
  });

  it("recognizes only Core's legacy and canonical main agent IDs", () => {
    expect(isCoreMainAgentId("main")).toBe(true);
    expect(isCoreMainAgentId("core:main")).toBe(true);
    expect(isCoreMainAgentId("some-app:main")).toBe(false);
  });
});

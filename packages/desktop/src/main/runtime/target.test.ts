import { describe, expect, it } from "@rstest/core";
import { parseRuntimeTarget, requireRuntimeTarget, sameTarget } from "./target";

const instance = { id: "instance-1", name: "ray", origin: "https://ray.romeos.cc" };
const remote = { kind: "remote", instance };
const welcome = { kind: "remote", instance: null };

describe("parseRuntimeTarget", () => {
  it("reads a saved target", () => {
    expect(parseRuntimeTarget(JSON.stringify(remote), true)).toEqual(remote);
    expect(parseRuntimeTarget(JSON.stringify(welcome), true)).toEqual(welcome);
    expect(parseRuntimeTarget(JSON.stringify({ kind: "local" }), false)).toEqual({ kind: "local" });
  });

  it("starts a new install at Rome Cloud sign-in", () => {
    expect(parseRuntimeTarget(null, false)).toEqual(welcome);
  });

  it("keeps an install that already has a VM on the VM", () => {
    // Upgrading must not hide the Rome that lives in the VM behind a sign-in.
    expect(parseRuntimeTarget(null, true)).toEqual({ kind: "local" });
    expect(parseRuntimeTarget("not json", true)).toEqual({ kind: "local" });
  });

  it("refuses an origin that is not an exact https origin", () => {
    for (const origin of ["http://ray.romeos.cc", "https://ray.romeos.cc/chat", "javascript:1"]) {
      const target = { kind: "remote", instance: { ...instance, origin } };
      expect(parseRuntimeTarget(JSON.stringify(target), false)).toEqual(welcome);
      expect(() => requireRuntimeTarget(target)).toThrow();
    }
  });
});

describe("sameTarget", () => {
  it("compares kind and instance", () => {
    expect(sameTarget({ kind: "local" }, { kind: "local" })).toBe(true);
    expect(sameTarget({ kind: "local" }, { kind: "remote", instance: null })).toBe(false);
    expect(sameTarget({ kind: "remote", instance }, { kind: "remote", instance: null })).toBe(
      false,
    );
    expect(sameTarget({ kind: "remote", instance }, { kind: "remote", instance })).toBe(true);
  });
});

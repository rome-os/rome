import { describe, expect, it } from "@rstest/core";
import { parseRuntimeTarget, requireRuntimeTarget, sameTarget } from "./target";

const instance = { id: "instance-1", name: "ray", origin: "https://ray.romeos.cc" };
const remote = { kind: "remote", instance };
const welcome = { kind: "remote", instance: null };

describe("parseRuntimeTarget", () => {
  it("reads a saved target", () => {
    expect(parseRuntimeTarget(JSON.stringify(remote))).toEqual(remote);
    expect(parseRuntimeTarget(JSON.stringify(welcome))).toEqual(welcome);
  });

  it("starts a new install at Rome Cloud sign-in", () => {
    expect(parseRuntimeTarget(null)).toEqual(welcome);
  });

  // Builds with a private VM saved this. Reading it must neither throw nor
  // reopen the VM: the app would sit on its startup page with nothing to start.
  it("moves an install that ran the private VM to Rome Cloud sign-in", () => {
    expect(parseRuntimeTarget(JSON.stringify({ kind: "local" }))).toEqual(welcome);
  });

  it("falls back to sign-in on anything it cannot read", () => {
    expect(parseRuntimeTarget("not json")).toEqual(welcome);
    expect(parseRuntimeTarget(JSON.stringify({ kind: "vm" }))).toEqual(welcome);
  });

  it("refuses an origin that is not an exact https origin", () => {
    for (const origin of ["http://ray.romeos.cc", "https://ray.romeos.cc/chat", "javascript:1"]) {
      const target = { kind: "remote", instance: { ...instance, origin } };
      expect(parseRuntimeTarget(JSON.stringify(target))).toEqual(welcome);
      expect(() => requireRuntimeTarget(target)).toThrow();
    }
  });
});

describe("requireRuntimeTarget", () => {
  it("refuses the private VM over IPC", () => {
    expect(() => requireRuntimeTarget({ kind: "local" })).toThrow();
  });
});

describe("sameTarget", () => {
  it("compares the instance", () => {
    expect(sameTarget({ kind: "remote", instance }, { kind: "remote", instance: null })).toBe(
      false,
    );
    expect(sameTarget({ kind: "remote", instance }, { kind: "remote", instance })).toBe(true);
    expect(sameTarget({ kind: "remote", instance: null }, { kind: "remote", instance: null })).toBe(
      true,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

const cp = rs.hoisted(() => ({ execFile: rs.fn() }));
rs.mock("node:child_process", () => ({ execFile: cp.execFile }));

import { createNodeCallerProvisioner } from "./rome-node-provisioning.js";
import { setInstanceTokenInMemory } from "./instance-identity.js";

const originalEnv = { ...process.env };
const token = "romeinst_current";
let finish: (error: Error | null) => void;

beforeEach(() => {
  cp.execFile.mockReset();
  cp.execFile.mockImplementation((_file, _args, _options, callback) => {
    finish = callback;
    return { stdin: { end: rs.fn() } };
  });
  process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
  process.env.ROME_INSTANCE_TOKEN = "romeinst_stale_env";
  delete process.env.PANTHEON_DOMAIN;
  setInstanceTokenInMemory(token);
});
afterEach(() => {
  process.env = { ...originalEnv };
  setInstanceTokenInMemory(null);
});

describe("Rome Node startup command", () => {
  it("passes the current token only to the child environment and shares overlapping calls", async () => {
    const ensure = createNodeCallerProvisioner();
    const first = ensure();
    const second = ensure();
    expect(cp.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = cp.execFile.mock.calls[0];
    expect(file).toBe("rome-node");
    expect(args).toEqual(["auth", "--server", "--cloud", "https://rome-cloud.example"]);
    expect(options.env.ROME_INSTANCE_TOKEN).toBe(token);
    expect(process.env.ROME_INSTANCE_TOKEN).toBe("romeinst_stale_env");
    expect(JSON.stringify(args)).not.toContain(token);
    finish(null);
    await Promise.all([first, second]);
  });

  it("does not start a child without an enrolled instance and Cloud origin", async () => {
    const ensure = createNodeCallerProvisioner();
    setInstanceTokenInMemory(null);
    await ensure();
    setInstanceTokenInMemory(token);
    delete process.env.PANTHEON_BASE_ORIGIN;
    await ensure();
    expect(cp.execFile).not.toHaveBeenCalled();
  });

  it("does not reject or retry CLI failures and can run again on the next lifecycle trigger", async () => {
    const ensure = createNodeCallerProvisioner();
    const first = ensure();
    finish(new Error("CLI failed"));
    await expect(first).resolves.toBeUndefined();
    expect(cp.execFile).toHaveBeenCalledTimes(1);
    const next = ensure();
    expect(cp.execFile).toHaveBeenCalledTimes(2);
    finish(null);
    await next;
  });
});

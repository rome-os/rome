import { describe, expect, it } from "@rstest/core";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A fresh process, so React has not been loaded before and NODE_ENV is under the test's control.
// It runs the built helper, which is what `rome-node connect` uses.
const script = `
import { createRequire } from "node:module";
const { loadConnectUi } = await import(process.argv[1]);
const ui = await loadConnectUi();
// Node also lists the other build of each package, unevaluated, while it scans CJS exports.
const cache = createRequire(import.meta.url).cache;
const loaded = Object.keys(cache).filter((file) => cache[file].loaded);
console.log(JSON.stringify({
  hasNodeEnv: "NODE_ENV" in process.env,
  nodeEnv: process.env.NODE_ENV,
  startConnectUi: typeof ui.startConnectUi,
  production: loaded.filter((file) => /react(-reconciler)?\\.production/.test(file)).length,
  development: loaded.filter((file) => /react(-reconciler)?\\.development/.test(file)).length,
}));
`;

function load(nodeEnv: string | undefined) {
  const env = { ...process.env };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  const helper = pathToFileURL(resolve("dist/load-connect-ui.js")).href;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, helper], {
    env,
    encoding: "utf8",
  });
  return JSON.parse(out) as {
    hasNodeEnv: boolean;
    nodeEnv?: string;
    startConnectUi: string;
    production: number;
    development: number;
  };
}

describe("loadConnectUi", () => {
  it("loads the production React build and removes NODE_ENV again when it was unset", () => {
    const result = load(undefined);
    expect(result.startConnectUi).toBe("function");
    expect(result.production).toBeGreaterThanOrEqual(2);
    expect(result.development).toBe(0);
    expect(result.hasNodeEnv).toBe(false);
  });

  it("puts a preset NODE_ENV back", () => {
    const result = load("development");
    expect(result.startConnectUi).toBe("function");
    expect(result.production).toBeGreaterThanOrEqual(2);
    expect(result.development).toBe(0);
    expect(result.nodeEnv).toBe("development");
  });
});

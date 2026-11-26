import { spawnSync } from "node:child_process";
import { expect, it } from "@rstest/core";

function run(args: string[], discoveryError?: string) {
  const hooks = `
    import { registerHooks } from "node:module";
    const source = \`
      export async function discoverHelper() {
        const code = ${JSON.stringify(discoveryError)};
        if (code) throw Object.assign(new Error(code), { code });
        return "/Applications/Rome Computer Use.app";
      }
      export async function launchPermissionSetup({ signal, ...options }) {
        console.log(JSON.stringify(options));
      }
    \`;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@rome-os/node-core/host") {
          return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) };
        }
        return nextResolve(specifier, context);
      },
    });
  `;
  return spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(hooks)}`, "bin/rome-node.js", ...args],
    { encoding: "utf8", timeout: 5000 },
  );
}

it("launches the local guide with the selected pane and locale", () => {
  const result = run(["computer-use", "setup", "--pane", "screen-recording", "--locale", "ja-JP"]);
  expect(result.status).toBe(0);
  const [options, guidance] = result.stdout.trim().split("\n");
  expect(JSON.parse(options)).toEqual({
    appPath: "/Applications/Rome Computer Use.app",
    pane: "screen-recording",
    locale: "ja-JP",
  });
  expect(guidance).toContain("System Settings");
});

it("shows help and rejects invalid or duplicate options before launching", () => {
  expect(run(["computer-use", "setup", "--help"]).stdout).toContain("[--pane");
  for (const args of [
    ["--pane", "unknown"],
    ["--pane", "all", "--pane", "accessibility"],
    ["--locale", "en", "--locale", "ja"],
  ]) {
    const result = run(["computer-use", "setup", ...args]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(args[0]);
  }
});

it.each([
  ["computer_use_unsupported_platform", "available on macOS"],
  ["computer_use_helper_missing", "Install the latest Rome Node"],
  ["invalid_helper_bundle", "Install the latest signed helper"],
])("prints guidance for %s without opening the guide", (code, message) => {
  const result = run(["computer-use", "setup"], code);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
});

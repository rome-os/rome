import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = "scripts/docker/rome-apply-cdp-stealth.sh";
const scriptSource = readFileSync(resolve(PROJECT_ROOT, SCRIPT_PATH), "utf8");
const helperSource = scriptSource.match(/^get_ua_architecture\(\) \{\n[\s\S]*?^}\n/m)?.[0];

if (!helperSource) {
  throw new Error("get_ua_architecture helper not found");
}

function getUaArchitecture(source: string) {
  const result = spawnSync(
    "bash",
    ["-c", `${helperSource}\nget_ua_architecture "$1"`, "get-ua-architecture", source],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describe("rome-apply-cdp-stealth.sh UA architecture", () => {
  it("detects Intel macOS user agents as x86", () => {
    expect(
      getUaArchitecture(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      ),
    ).toBe("x86");
  });

  it("normalizes architecture tokens before matching", () => {
    expect(
      getUaArchitecture("Mozilla/5.0 (X11; Linux ARM64) AppleWebKit/537.36 Chrome/133.0.0.0"),
    ).toBe("arm");
    expect(
      getUaArchitecture("Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 Chrome/133.0.0.0"),
    ).toBe("x86");
  });
});

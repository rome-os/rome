import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = "scripts/docker/rome-apply-cdp-stealth.sh";
const scriptSource = readFileSync(resolve(PROJECT_ROOT, SCRIPT_PATH), "utf8");
const helperSource = scriptSource.match(/^get_ua_architecture\(\) \{\n[\s\S]*?^}\n/m)?.[0];
const guardSource = scriptSource.match(/  python3 <<'PY'\n([\s\S]*)\nPY\s*$/)?.[1];

if (!helperSource) {
  throw new Error("get_ua_architecture helper not found");
}

if (!guardSource) {
  throw new Error("embedded CDP guard not found");
}

type CdpCommand = { method: string; sessionId?: string; params?: Record<string, unknown> };

function runGuard(
  scenario: "idle" | "command-timeout" | "existing" | "empty" | "nested-iframes",
  userAgent = "TestChrome",
) {
  const directory = mkdtempSync(join(tmpdir(), "rome-stealth-guard-"));
  const traceFile = join(directory, "commands.json");
  const readyFile = join(directory, "ready");
  try {
    copyFileSync(
      resolve(PROJECT_ROOT, "scripts/docker/fixtures/stealth-websocket.py"),
      join(directory, "websocket.py"),
    );
    // Postpone annotations so the container's Python code also runs under host Python 3.9.
    const result = spawnSync(
      "python3",
      ["-c", `from __future__ import annotations\n${guardSource}`],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 2_000,
        env: {
          ...process.env,
          PYTHONPATH: directory,
          CDP_SCENARIO: scenario,
          CDP_TRACE_FILE: traceFile,
          BROWSER_WS: "ws://test.invalid/browser",
          STEALTH_JS_FILE: resolve(PROJECT_ROOT, "scripts/docker/stealth-inject.js"),
          READY_FILE: readyFile,
          TIMEZONE: "America/Los_Angeles",
          CHROME_LANG: "en-US",
          CHROME_USER_AGENT: userAgent,
          ACCEPT_LANG: "en-US,en;q=0.9",
          STEALTH_LANGUAGES: '["en-US", "en"]',
          UA_METADATA: '{"platform":"Linux"}',
          GEO_PARAMS: '{"latitude":34,"longitude":-118,"accuracy":100}',
        },
      },
    );
    expect(result.error).toBeUndefined();
    if (!existsSync(traceFile)) {
      throw new Error(`CDP fixture did not finish: ${result.stderr}`);
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ready: existsSync(readyFile),
      commands: JSON.parse(readFileSync(traceFile, "utf8")) as CdpCommand[],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

describe("rome-apply-cdp-stealth.sh guard lifecycle", () => {
  it("keeps native user-agent metadata when no override is configured", () => {
    const result = runGuard("idle", "");

    expect(result.ready).toBe(true);
    expect(result.stdout).toContain("stealth configured for page new");
    expect(
      result.commands.some((command) => command.method === "Network.setUserAgentOverride"),
    ).toBe(false);
  });

  it("applies an explicitly configured user agent", () => {
    const result = runGuard("existing", "ConfiguredChrome");

    expect(result.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.setUserAgentOverride",
        params: expect.objectContaining({ userAgent: "ConfiguredChrome" }),
      }),
    );
  });

  it("handles a new tab after repeated idle timeouts and exits on disconnect", () => {
    const result = runGuard("idle");

    expect(result.ready).toBe(true);
    expect(result.stdout).toContain("stealth configured for page new");
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "session-new",
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("[stealth] browser CDP connection closed\n");
  });

  it("configures each existing tab once through automatic attachment", () => {
    const result = runGuard("existing");

    expect(result.stdout.match(/stealth configured for page existing/g)).toHaveLength(1);
    expect(
      result.commands.filter((command) => command.method === "Emulation.setLocaleOverride"),
    ).toHaveLength(2);
  });

  it("configures and resumes the initial tab when the browser starts without pages", () => {
    const result = runGuard("empty");

    expect(result.ready).toBe(true);
    expect(result.stdout.match(/stealth configured for page created/g)).toHaveLength(1);
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "session-created",
      }),
    );
  });

  it("reports a command timeout and still resumes the affected tab", () => {
    const result = runGuard("command-timeout");

    expect(result.stdout).toContain("stealth injection failed on page new: CDP response timed out");
    expect(result.stdout).not.toContain("stealth configured for page new");
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "session-new",
      }),
    );
    expect(result.stderr).toBe("[stealth] browser CDP connection closed\n");
  });

  it("configures existing and new nested iframes before resuming their scripts", () => {
    const result = runGuard("nested-iframes");
    const frames = [
      "existing-frame",
      "existing-nested-frame",
      "new-frame",
      "new-nested-frame",
      "late-nested-frame",
    ];

    expect(result.ready).toBe(true);
    for (const frame of frames) {
      const commands = result.commands.filter(
        (command) => command.sessionId === `session-${frame}`,
      );
      expect(commands).toContainEqual(
        expect.objectContaining({
          method: "Target.setAutoAttach",
          params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
        }),
      );
      expect(
        commands.filter((command) => command.method === "Page.addScriptToEvaluateOnNewDocument"),
      ).toHaveLength(1);
      expect(commands.filter((command) => command.method === "Page.enable")).toHaveLength(1);
      expect(result.stdout).toContain(`stealth configured for iframe ${frame}`);
    }

    for (const target of ["new", "new-frame", "new-nested-frame", "late-nested-frame"]) {
      const methods = result.commands
        .filter((command) => command.sessionId === `session-${target}`)
        .map((command) => command.method);
      const resumeIndex = methods.indexOf("Runtime.runIfWaitingForDebugger");
      expect(resumeIndex).toBeGreaterThan(methods.indexOf("Target.setAutoAttach"));
      expect(resumeIndex).toBeGreaterThan(methods.indexOf("Page.addScriptToEvaluateOnNewDocument"));
      expect(resumeIndex).toBeGreaterThan(methods.indexOf("Page.enable"));
    }
    expect(result.stdout).not.toContain("stealth injection failed");
    expect(result.stderr).toBe("[stealth] browser CDP connection closed\n");
  });
});

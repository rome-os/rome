import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createFakeOpencli } from "../../test/fake-opencli.js";
import { openAutomationPage, type RunOpencli, runOpencli } from "./browser-page.js";

const PAGE_URL = "https://chatgpt.example/";
const NO_CDP_ENDPOINTS = { getBrowserEndpoints: () => [] };

const scriptDir = mkdtempSync(join(tmpdir(), "browser-page-test-"));
const GATED_ECHO_SCRIPT = writeScript(
  "gated_echo.js",
  `async function gatedEcho(input) {
  await globalThis.__test.gate;
  return { echoed: input, href: location.href };
}`,
);
const FAILING_SCRIPT = writeScript(
  "failing.js",
  `async function failNow() {
  throw new Error("ChatGPT composer was not found");
}`,
);

describe("openAutomationPage over OpenCLI", () => {
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it("opens the page through the Browser Bridge when CDP discovery found no browser", async () => {
    const fake = createFakeOpencli();

    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });

    expect(page.browser).toBe("opencli");
    expect(fake.calls[0]).toEqual([
      "browser",
      expect.stringMatching(/^rome-test-[0-9a-f-]{36}$/),
      "open",
      PAGE_URL,
    ]);
    const session = fake.calls[0][1];
    expect(fake.calls.every((args) => args[0] === "browser" && args[1] === session)).toBe(true);

    await page.close();
    expect(fake.subcommands().at(-1)).toBe("close");
  });

  it("returns a script's result after it outlives several OpenCLI calls", async () => {
    const fake = createFakeOpencli({ maxPageTimerMs: 5 });
    let release: () => void = () => {};
    fake.testGlobals.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });
    const evalsBeforeScript = countEvals(fake.subcommands());

    const result = page.runScript({
      scriptUrl: GATED_ECHO_SCRIPT,
      entrypointExpression: "gatedEcho",
      args: [{ prompt: "Reply with OK", timeout: 60_000 }],
      autorunFlag: "__TEST_AUTORUN__",
      timeoutMs: 60_000,
    });
    await waitUntil(() => countEvals(fake.subcommands()) >= evalsBeforeScript + 5);
    release();

    await expect(result).resolves.toEqual({
      echoed: { prompt: "Reply with OK", timeout: 60_000 },
      href: PAGE_URL,
    });
  });

  it("stages a prompt longer than one argv entry in chunks without corrupting it", async () => {
    const fake = createFakeOpencli();
    fake.testGlobals.gate = Promise.resolve();
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });
    // Surrogate pairs make some chunk boundaries split a character.
    const prompt = `${"Summarize this. ".repeat(4_000)}${"\u{1F600}".repeat(40_000)}`;

    const result = await page.runScript<{ echoed: { prompt: string } }>({
      scriptUrl: GATED_ECHO_SCRIPT,
      entrypointExpression: "gatedEcho",
      args: [{ prompt }],
      timeoutMs: 60_000,
    });

    expect(result.echoed.prompt).toBe(prompt);
    const longestArg = Math.max(...fake.calls.flat().map((arg) => arg.length));
    expect(longestArg).toBeLessThan(64 * 1024);
  });

  it("rejects with the script's own error message", async () => {
    const fake = createFakeOpencli();
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });

    await expect(
      page.runScript({
        scriptUrl: FAILING_SCRIPT,
        entrypointExpression: "failNow",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("ChatGPT composer was not found");
  });

  it("reports a missing entrypoint by name", async () => {
    const fake = createFakeOpencli();
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });

    await expect(
      page.runScript({
        scriptUrl: FAILING_SCRIPT,
        entrypointExpression: "notThere",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("notThere is not defined");
  });

  it("rejects when a navigation discards a running script", async () => {
    const fake = createFakeOpencli({ maxPageTimerMs: 5 });
    fake.testGlobals.gate = new Promise(() => {});
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });
    const evalsBeforeScript = countEvals(fake.subcommands());

    const result = page.runScript({
      scriptUrl: GATED_ECHO_SCRIPT,
      entrypointExpression: "gatedEcho",
      timeoutMs: 60_000,
    });
    await waitUntil(() => countEvals(fake.subcommands()) >= evalsBeforeScript + 3);
    fake.navigate("https://chatgpt.example/auth/login");

    await expect(result).rejects.toThrow(/navigated away or reloaded/);
  });

  it("reports lost input when a navigation lands between two staged chunks", async () => {
    const fake = createFakeOpencli();
    fake.testGlobals.gate = Promise.resolve();
    let evalsBeforeScript = Number.POSITIVE_INFINITY;
    // Staging is the first eval a script makes, so the navigation drops chunk 0.
    const navigatingAfterFirstChunk: RunOpencli = async (args, options) => {
      const result = await fake.run(args, options);
      if (countEvals(fake.subcommands()) === evalsBeforeScript + 1) {
        fake.navigate(PAGE_URL);
      }
      return result;
    };
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: navigatingAfterFirstChunk,
    });
    evalsBeforeScript = countEvals(fake.subcommands());

    await expect(
      page.runScript({
        scriptUrl: GATED_ECHO_SCRIPT,
        entrypointExpression: "gatedEcho",
        args: [{ prompt: "Summarize this. ".repeat(6_000) }],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("The page reloaded before the browser script started");
  });

  it("returns a finished script's result when OpenCLI drops the poll that reported it", async () => {
    const fake = createFakeOpencli();
    fake.testGlobals.gate = Promise.resolve();
    let dropped = false;
    // The page runs the poll, and its output never reaches Rome.
    const droppingFirstResult: RunOpencli = async (args, options) => {
      const result = await fake.run(args, options);
      if (!dropped && result.stdout.includes('"state":"done"')) {
        dropped = true;
        return { code: 1, stdout: "", stderr: "Browser Bridge connection reset" };
      }
      return result;
    };
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: droppingFirstResult,
    });

    await expect(
      page.runScript({
        scriptUrl: GATED_ECHO_SCRIPT,
        entrypointExpression: "gatedEcho",
        args: ["hello"],
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ echoed: "hello", href: PAGE_URL });
    expect(dropped).toBe(true);
  });

  it("fails at once when OpenCLI reports a script state it does not recognize", async () => {
    const fake = createFakeOpencli({ maxPageTimerMs: 5 });
    fake.testGlobals.gate = new Promise(() => {});
    // A poll result that arrives JSON-encoded a second time parses to a string.
    const doubleEncodingPolls: RunOpencli = async (args, options) => {
      const result = await fake.run(args, options);
      if (result.stdout.includes('"state"')) {
        return { ...result, stdout: `${JSON.stringify(result.stdout.trim())}\n` };
      }
      return result;
    };
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: doubleEncodingPolls,
    });

    await expect(
      page.runScript({
        scriptUrl: GATED_ECHO_SCRIPT,
        entrypointExpression: "gatedEcho",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("unexpected browser script state");
  });

  it("waits for the reloaded document at the expected URL", async () => {
    const conversationUrl = "https://chatgpt.example/c/example-conversation";
    const fake = createFakeOpencli();
    fake.testGlobals.gate = Promise.resolve();
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, conversationUrl, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });

    await page.reload(conversationUrl);

    await expect(
      page.runScript({
        scriptUrl: GATED_ECHO_SCRIPT,
        entrypointExpression: "gatedEcho",
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ href: conversationUrl });
  });

  it("reads a script result printed before an OpenCLI notice", async () => {
    const fake = createFakeOpencli();
    fake.testGlobals.gate = Promise.resolve();
    const withNotice: RunOpencli = async (args, options) => {
      const result = await fake.run(args, options);
      return {
        ...result,
        stdout: `${result.stdout}\n  Extension update available: v1.0.24 -> v1.0.26\n  Download: https://example.com/releases\n`,
      };
    };
    const page = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: withNotice,
    });

    await expect(
      page.runScript({
        scriptUrl: GATED_ECHO_SCRIPT,
        entrypointExpression: "gatedEcho",
        args: ["hello"],
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ echoed: "hello", href: PAGE_URL });
  });

  it("names the Browser Bridge and the profile input when OpenCLI cannot open the page", async () => {
    const fake = createFakeOpencli({
      openResult: {
        code: 1,
        stdout: "",
        stderr:
          "\u001b[31mBrowser Bridge extension not connected\u001b[0m\nHint: Make sure Chrome/Chromium is open and the OpenCLI extension is enabled.\n",
      },
    });

    const error = await openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("OpenCLI's Browser Bridge");
    expect(message).toContain("Browser Bridge extension not connected");
    expect(message).toContain("`opencli profile list`");
    expect(message).toContain("`profile`");
    expect(message).toContain("Settings > Advanced > Computer Use");
    expect(message).not.toContain("\u001b[");
    expect(message).not.toContain("No discovered browser endpoints");
    expect(fake.subcommands()).toEqual(["open"]);
  });

  it("routes an explicit profile through OpenCLI even when CDP discovery found a browser", async () => {
    const fake = createFakeOpencli();
    const discovery = {
      getBrowserEndpoints: () => [{ name: "cdp-local-chromium", browserUrl: "http://127.0.0.1:1" }],
    };

    const page = await openAutomationPage(discovery, PAGE_URL, {
      profile: " work ",
      sessionPrefix: "rome-test",
      runOpencli: fake.run,
    });

    expect(page.browser).toBe("opencli:work");
    expect(fake.calls.every((args) => args[0] === "--profile" && args[1] === "work")).toBe(true);
  });

  it("refuses a profile that OpenCLI would read as a flag", async () => {
    const fake = createFakeOpencli();

    await expect(
      openAutomationPage(NO_CDP_ENDPOINTS, PAGE_URL, {
        profile: "--cdp-endpoint",
        sessionPrefix: "rome-test",
        runOpencli: fake.run,
      }),
    ).rejects.toThrow("profile must be a name or id");
    expect(fake.calls).toEqual([]);
  });
});

describe("runOpencli", () => {
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it("names OpenCLI and the CDP alternative when the binary is missing", async () => {
    rs.stubEnv("ROME_OPENCLI_BIN", join(scriptDir, "missing-opencli"));

    await expect(runOpencli(["--version"], { timeoutMs: 5_000 })).rejects.toThrow(
      /needs OpenCLI.*could not be run.*ROME_ENABLE_CDP_AUTOMATION=true/s,
    );
  });
});

function writeScript(name: string, source: string): URL {
  const path = join(scriptDir, name);
  writeFileSync(path, source);
  return pathToFileURL(path);
}

function countEvals(subcommands: string[]): number {
  return subcommands.filter((subcommand) => subcommand === "eval").length;
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition was not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

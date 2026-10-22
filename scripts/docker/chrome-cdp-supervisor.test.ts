import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@rstest/core";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = "scripts/docker/rome-start-chrome-cdp.sh";

let supervisor: ChildProcessWithoutNullStreams | null = null;
let tempDirs: string[] = [];

afterEach(async () => {
  if (supervisor && supervisor.exitCode === null) {
    supervisor.kill("SIGTERM");
    await new Promise<void>((resolveWait) => supervisor!.once("exit", () => resolveWait()));
  }
  supervisor = null;

  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeExecutable(path: string, content: string) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

async function waitForCount(path: string, minimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = Number.parseInt(readFileSync(path, "utf8").trim() || "0", 10);
    if (count >= minimum) return count;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return Number.parseInt(readFileSync(path, "utf8").trim() || "0", 10);
}

describe("rome-start-chrome-cdp.sh", () => {
  it.each([
    [undefined, undefined, false],
    ["true", undefined, true],
    ["true", "0", false],
  ] as const)("gates stealth with CDP automation=%s and stealth=%s", async (automationEnabled, stealthEnabled, expectStealth) => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);
    const binDir = join(tempDir, "bin");
    const countFile = join(tempDir, "chrome-count");
    const argsFile = join(tempDir, "chrome-args");
    const stealthFile = join(tempDir, "stealth-started");
    const scriptPath = join(tempDir, "rome-start-chrome-cdp.sh");
    mkdirSync(binDir);
    writeFileSync(countFile, "0\n");
    writeFileSync(stealthFile, "0\n");
    writeFileSync(scriptPath, readFileSync(resolve(PROJECT_ROOT, SCRIPT_PATH)));
    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
[[ "$(cat "$FAKE_CHROME_COUNT_FILE")" == "1" ]] || exit 1
echo cdp-ready
`,
    );
    makeExecutable(join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n");
    makeExecutable(
      join(tempDir, "rome-apply-cdp-stealth.sh"),
      `#!/usr/bin/env bash
printf '1\\n' >"$FAKE_STEALTH_FILE"
exec sleep 30
`,
    );
    makeExecutable(
      join(tempDir, "fake-chrome"),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FAKE_CHROME_ARGS_FILE"
printf '1\\n' >"$FAKE_CHROME_COUNT_FILE"
exec sleep 30
`,
    );

    supervisor = spawn("bash", [scriptPath], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_CHROME_ARGS_FILE: argsFile,
        FAKE_CHROME_COUNT_FILE: countFile,
        FAKE_STEALTH_FILE: stealthFile,
        ROME_ENABLE_CDP_AUTOMATION: automationEnabled,
        ROME_CHROME_ENABLE_STEALTH: stealthEnabled,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_KEEP_ALIVE: "0",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });
    await new Promise<void>((resolveWait, reject) => {
      supervisor!.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("cdp-ready")) resolveWait();
      });
      supervisor!.once("exit", (code) => reject(new Error(`Chrome supervisor exited: ${code}`)));
    });

    const stealthCount = expectStealth
      ? await waitForCount(stealthFile, 1)
      : Number(readFileSync(stealthFile, "utf8").trim());
    expect(supervisor.exitCode).toBeNull();
    expect(readFileSync(countFile, "utf8").trim()).toBe("1");
    expect(readFileSync(argsFile, "utf8")).toContain("--remote-debugging-port=");
    expect(stealthCount).toBe(expectStealth ? 1 : 0);
  });

  it("restarts Chrome when the browser process exits", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    const countFile = join(tempDir, "chrome-count");
    const argsFile = join(tempDir, "chrome-args");
    mkdirSync(binDir);
    writeFileSync(countFile, "0\n", "utf8");

    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
printf '{"User-Agent":"FakeChrome"}\\n'
`,
    );
    makeExecutable(
      join(binDir, "socat"),
      `#!/usr/bin/env bash
trap 'exit 0' INT TERM
while true; do sleep 1; done
`,
    );
    makeExecutable(
      join(tempDir, "fake-chrome"),
      `#!/usr/bin/env bash
count="$(cat "$FAKE_CHROME_COUNT_FILE")"
count=$((count + 1))
printf '%s\\n' "$count" >"$FAKE_CHROME_COUNT_FILE"
printf '%s\\n' "$@" >"$FAKE_CHROME_ARGS_FILE"
sleep 0.1
`,
    );

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_CHROME_COUNT_FILE: countFile,
        FAKE_CHROME_ARGS_FILE: argsFile,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "0.1",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });

    const count = await waitForCount(countFile, 2);
    const chromeArgs = readFileSync(argsFile, "utf8").trim().split("\n");

    expect(count).toBeGreaterThanOrEqual(2);
    expect(chromeArgs).toContain("--use-gl=angle");
    expect(chromeArgs).toContain("--use-angle=swiftshader-webgl");
    expect(chromeArgs).toContain("--enable-unsafe-swiftshader");
    expect(chromeArgs).not.toContain("--disable-gpu");
    expect(chromeArgs.filter((arg) => arg.startsWith("--disable-features="))).toEqual([
      "--disable-features=IgnoreDuplicateNavs",
    ]);
    expect(supervisor.exitCode).toBeNull();
  });

  it("clears leftover BrowserMetrics files before each launch", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    const countFile = join(tempDir, "chrome-count");
    const profileDir = join(tempDir, "profile");
    const metricsDir = join(profileDir, "BrowserMetrics");
    mkdirSync(binDir);
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(countFile, "0\n", "utf8");
    writeFileSync(join(metricsDir, "BrowserMetrics-stale.pma"), "stale");
    writeFileSync(join(profileDir, "BrowserMetrics-spare.pma"), "spare");

    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
printf '{"User-Agent":"FakeChrome"}\\n'
`,
    );
    makeExecutable(
      join(binDir, "socat"),
      `#!/usr/bin/env bash
trap 'exit 0' INT TERM
while true; do sleep 1; done
`,
    );
    makeExecutable(
      join(tempDir, "fake-chrome"),
      `#!/usr/bin/env bash
count="$(cat "$FAKE_CHROME_COUNT_FILE")"
count=$((count + 1))
printf 'metrics' >"$FAKE_CHROME_METRICS_DIR/BrowserMetrics-$count.pma"
printf '%s\\n' "$count" >"$FAKE_CHROME_COUNT_FILE"
sleep 0.1
`,
    );

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_CHROME_COUNT_FILE: countFile,
        FAKE_CHROME_METRICS_DIR: metricsDir,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "0.05",
        ROME_CHROME_MAX_RESTART_DELAY: "0.1",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: profileDir,
      },
    });

    const count = await waitForCount(countFile, 3);
    const metricsFiles = readdirSync(metricsDir);

    expect(count).toBeGreaterThanOrEqual(3);
    expect(metricsFiles).not.toContain("BrowserMetrics-stale.pma");
    expect(metricsFiles.length).toBeLessThanOrEqual(1);
    expect(existsSync(join(profileDir, "BrowserMetrics-spare.pma"))).toBe(true);
    expect(supervisor.exitCode).toBeNull();
  });

  it("backs off exponentially while Chrome keeps failing to start", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    mkdirSync(binDir);

    makeExecutable(join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");
    makeExecutable(join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n");
    makeExecutable(join(tempDir, "fake-chrome"), "#!/usr/bin/env bash\nexit 1\n");

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "0.1",
        ROME_CHROME_MAX_RESTART_DELAY: "0.4",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });

    let output = "";
    supervisor.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const retryDelays = () =>
      [...output.matchAll(/retrying in ([\d.]+)s/g)].map((match) => match[1]);
    const deadline = Date.now() + 5_000;
    while (retryDelays().length < 4 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    expect(retryDelays().slice(0, 4)).toEqual(["0.1", "0.2", "0.4", "0.4"]);
    expect(supervisor.exitCode).toBeNull();
  });

  it("clears a metrics backlog too large to pass as arguments", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    const profileDir = join(tempDir, "profile");
    const metricsDir = join(profileDir, "BrowserMetrics");
    mkdirSync(binDir);
    mkdirSync(metricsDir, { recursive: true });
    // A crash loop leaves tens of thousands of these. Together their paths
    // exceed the argument limit on Linux and macOS.
    for (let i = 0; i < 25_000; i += 1)
      writeFileSync(join(metricsDir, `BrowserMetrics-${"0".repeat(48)}-${i}.pma`), "");

    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash\nprintf '{"User-Agent":"FakeChrome"}\\n'\n`,
    );
    makeExecutable(join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n");
    makeExecutable(join(tempDir, "fake-chrome"), "#!/usr/bin/env bash\nexec sleep 30\n");

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: profileDir,
      },
    });
    // The supervisor prints CDP's version once Chrome is up.
    await new Promise<void>((resolveWait, reject) => {
      supervisor!.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("FakeChrome")) resolveWait();
      });
      supervisor!.once("exit", (code) => reject(new Error(`Chrome supervisor exited: ${code}`)));
    });

    expect(readdirSync(metricsDir)).toEqual([]);
  }, 30_000);

  it("stops at once when terminated during a backoff", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    mkdirSync(binDir);
    makeExecutable(join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");
    makeExecutable(join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n");
    makeExecutable(join(tempDir, "fake-chrome"), "#!/usr/bin/env bash\nexit 1\n");

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "20",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });
    await new Promise<void>((resolveWait) => {
      supervisor!.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("retrying in 20s")) resolveWait();
      });
    });

    const stoppedAt = Date.now();
    supervisor.kill("SIGTERM");
    await new Promise<void>((resolveWait) => supervisor!.once("exit", () => resolveWait()));

    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
  });

  it("restarts Chrome after a clean exit without backing off", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    mkdirSync(binDir);
    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash\nprintf '{"User-Agent":"FakeChrome"}\\n'\n`,
    );
    makeExecutable(join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n");
    makeExecutable(join(tempDir, "fake-chrome"), "#!/usr/bin/env bash\nsleep 0.1\n");

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "0.1",
        ROME_CHROME_MAX_RESTART_DELAY: "10",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });

    let output = "";
    supervisor.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const restartDelays = () =>
      [...output.matchAll(/status 0 after \d+s; restarting in ([\d.]+)s/g)].map(
        (match) => match[1],
      );
    const deadline = Date.now() + 5_000;
    while (restartDelays().length < 3 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    expect(restartDelays().slice(0, 3)).toEqual(["0.1", "0.1", "0.1"]);
  });

  it.each([
    // A cap below the restart delay is raised to it, never to no wait at all.
    ["0", ["0.1", "0.1", "0.1"]],
    // A cap that is not a number falls back to the default.
    ["soon", ["0.1", "0.2", "0.4"]],
  ] as const)("names and replaces a delay cap of %s", async (cap, expected) => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    mkdirSync(binDir);
    makeExecutable(join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");
    makeExecutable(join(binDir, "socat"), "#!/usr/bin/env bash\nexec sleep 30\n");
    makeExecutable(join(tempDir, "fake-chrome"), "#!/usr/bin/env bash\nexit 1\n");

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ROME_CHROME_BINARY: join(tempDir, "fake-chrome"),
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "0.1",
        ROME_CHROME_MAX_RESTART_DELAY: cap,
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });

    let output = "";
    let errors = "";
    supervisor.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    supervisor.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const retryDelays = () =>
      [...output.matchAll(/retrying in ([\d.]+)s/g)].map((match) => match[1]);
    const deadline = Date.now() + 5_000;
    while (retryDelays().length < 3 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    expect(retryDelays().slice(0, 3)).toEqual(expected);
    expect(errors).toContain(`ROME_CHROME_MAX_RESTART_DELAY=${cap}`);
  });

  it("bypasses the Debian Chromium wrapper and strips Google OAuth env vars", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rome-chrome-supervisor-"));
    tempDirs.push(tempDir);

    const binDir = join(tempDir, "bin");
    const countFile = join(tempDir, "chromium-count");
    const argsFile = join(tempDir, "chromium-args");
    const envFile = join(tempDir, "chromium-env");
    const wrapperUsedFile = join(tempDir, "wrapper-used");
    const wrapperPath = join(tempDir, "chromium");
    const directPath = join(tempDir, "direct-chromium");
    mkdirSync(binDir);
    writeFileSync(countFile, "0\n", "utf8");

    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
printf '{"User-Agent":"FakeChrome"}\\n'
`,
    );
    makeExecutable(
      join(binDir, "socat"),
      `#!/usr/bin/env bash
trap 'exit 0' INT TERM
while true; do sleep 1; done
`,
    );
    makeExecutable(
      wrapperPath,
      `#!/usr/bin/env bash
printf 'wrapper used\\n' >"$FAKE_CHROMIUM_WRAPPER_USED_FILE"
exit 73
`,
    );
    makeExecutable(
      directPath,
      `#!/usr/bin/env bash
count="$(cat "$FAKE_CHROMIUM_COUNT_FILE")"
count=$((count + 1))
printf '%s\\n' "$count" >"$FAKE_CHROMIUM_COUNT_FILE"
printf '%s\\n' "$@" >"$FAKE_CHROMIUM_ARGS_FILE"
env | sort | grep -E \
  '^(GOOGLE_API_KEY|GOOGLE_DEFAULT_CLIENT_ID|GOOGLE_DEFAULT_CLIENT_SECRET)=' \
  >"$FAKE_CHROMIUM_ENV_FILE" || true
sleep 0.1
`,
    );

    supervisor = spawn("bash", [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FAKE_CHROMIUM_ARGS_FILE: argsFile,
        FAKE_CHROMIUM_COUNT_FILE: countFile,
        FAKE_CHROMIUM_ENV_FILE: envFile,
        FAKE_CHROMIUM_WRAPPER_USED_FILE: wrapperUsedFile,
        GOOGLE_API_KEY: "deb-api-key",
        GOOGLE_DEFAULT_CLIENT_ID: "deb-client-id",
        GOOGLE_DEFAULT_CLIENT_SECRET: "deb-client-secret",
        ROME_CHROME_BINARY: wrapperPath,
        ROME_CHROME_DIRECT_BINARY: directPath,
        ROME_CHROME_ENABLE_STEALTH: "0",
        ROME_CHROME_KEEP_ALIVE: "1",
        ROME_CHROME_RESTART_DELAY: "0.1",
        ROME_CHROME_STARTUP_WAIT: "1",
        ROME_CHROME_USER_AGENT: "FakeChrome",
        ROME_CHROME_USER_DATA_DIR: join(tempDir, "profile"),
      },
    });

    const count = await waitForCount(countFile, 2);
    const chromeArgs = readFileSync(argsFile, "utf8").trim().split("\n");
    const googleEnv = readFileSync(envFile, "utf8").trim();

    expect(count).toBeGreaterThanOrEqual(2);
    expect(existsSync(wrapperUsedFile)).toBe(false);
    expect(chromeArgs).toContain(`--user-data-dir=${join(tempDir, "profile")}`);
    expect(chromeArgs.filter((arg) => arg.startsWith("--disable-features="))).toEqual([
      "--disable-features=IgnoreDuplicateNavs",
    ]);
    expect(googleEnv).toBe("");
    expect(supervisor.exitCode).toBeNull();
  });
});

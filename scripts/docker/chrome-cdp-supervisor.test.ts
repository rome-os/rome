import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
    ["false", "1", false],
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
    expect(supervisor.exitCode).toBeNull();
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
    expect(googleEnv).toBe("");
    expect(supervisor.exitCode).toBeNull();
  });
});

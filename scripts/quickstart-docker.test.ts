import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./quickstart-docker.sh", import.meta.url));

// A stub `docker` on PATH satisfies every subcommand the script issues (info,
// ps, rm, logs, inspect) and records the `docker run` argv, so the full flow —
// preflight, arg assembly, readiness wait — executes without a daemon. `logs`
// prints the readiness line immediately, so the wait loop never sleeps.
const DOCKER_STUB = `#!/usr/bin/env bash
case "$1" in
  run) shift; printf '%s\\n' "$@" > "$DOCKER_STUB_ARGS_FILE"; echo cid ;;
  logs) echo "Rome started" ;;
  inspect) echo true ;;
  *) exit 0 ;;
esac
`;

describe("quickstart-docker.sh container env", () => {
  let workDir: string;
  let argsFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "quickstart-docker-test-"));
    argsFile = join(workDir, "docker-run-args.txt");
    const stub = join(workDir, "docker");
    await writeFile(stub, DOCKER_STUB);
    await chmod(stub, 0o755);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function runQuickstart(
    env: Record<string, string> = {},
    args: string[] = [],
  ): Promise<string[]> {
    // The vars under test must come only from the per-case `env`, not leak in
    // from the host shell that happens to run the test runner.
    const base = { ...process.env };
    delete base.PANTHEON_BASE_ORIGIN;
    delete base.ROME_LOOPBACK_CALLBACK_ORIGIN;
    delete base.ROME_QUICKSTART_ENV_FILE;
    delete base.ROME_QUICKSTART_HOST_PORT;
    await execFileAsync(script, ["--no-pull", ...args], {
      env: {
        ...base,
        PATH: `${workDir}:${process.env.PATH}`,
        DOCKER_STUB_ARGS_FILE: argsFile,
        ROME_QUICKSTART_STATE_DIR: join(workDir, "state"),
        ...env,
      },
    });
    return (await readFile(argsFile, "utf8")).split("\n");
  }

  async function writeEnvFile(content: string): Promise<string> {
    const envFile = join(workDir, "extra.env");
    await writeFile(envFile, content);
    return envFile;
  }

  it("defaults the cloud origin and the callback to the published port", async () => {
    const args = await runQuickstart();
    expect(args).toContain("PANTHEON_BASE_ORIGIN=https://romeos.cc");
    expect(args).toContain("ROME_LOOPBACK_CALLBACK_ORIGIN=http://localhost:7663");
  });

  it("forwards a shell origin override verbatim", async () => {
    const args = await runQuickstart({ PANTHEON_BASE_ORIGIN: "https://staging.example" });
    expect(args).toContain("PANTHEON_BASE_ORIGIN=https://staging.example");
  });

  it("forwards an exported-empty origin as an explicit empty (cloud off)", async () => {
    const args = await runQuickstart({ PANTHEON_BASE_ORIGIN: "" });
    expect(args).toContain("PANTHEON_BASE_ORIGIN=");
  });

  it("lets an env file own the origin when the shell is silent", async () => {
    const envFile = await writeEnvFile("PANTHEON_BASE_ORIGIN=https://from-file.example\n");
    const args = await runQuickstart({}, ["--env-file", envFile]);
    // No -e flag at all: docker gives -e precedence over --env-file, so the
    // default must stand aside for the env file to be honored.
    expect(args.filter((a) => a.startsWith("PANTHEON_BASE_ORIGIN="))).toEqual([]);
    expect(args).toContain("--env-file");
  });

  it("prefers a shell origin over an env-file pin", async () => {
    const envFile = await writeEnvFile("PANTHEON_BASE_ORIGIN=https://from-file.example\n");
    const args = await runQuickstart({ PANTHEON_BASE_ORIGIN: "https://from-shell.example" }, [
      "--env-file",
      envFile,
    ]);
    expect(args).toContain("PANTHEON_BASE_ORIGIN=https://from-shell.example");
  });

  it("prefers an exported-empty origin over an env-file pin", async () => {
    const envFile = await writeEnvFile("PANTHEON_BASE_ORIGIN=https://from-file.example\n");
    const args = await runQuickstart({ PANTHEON_BASE_ORIGIN: "" }, ["--env-file", envFile]);
    expect(args).toContain("PANTHEON_BASE_ORIGIN=");
  });

  it("derives the callback origin from --port", async () => {
    const args = await runQuickstart({}, ["--port", "9999"]);
    expect(args).toContain("ROME_LOOPBACK_CALLBACK_ORIGIN=http://localhost:9999");
  });

  it("forwards a shell callback override verbatim", async () => {
    const args = await runQuickstart({
      ROME_LOOPBACK_CALLBACK_ORIGIN: "http://127.0.0.1:4444",
    });
    expect(args).toContain("ROME_LOOPBACK_CALLBACK_ORIGIN=http://127.0.0.1:4444");
  });
});

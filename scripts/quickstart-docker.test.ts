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
// ps, rm, logs, inspect) and records the `docker run` argv (the last run in the
// args file, every run in its `.all` sibling, signer first), so the full flow —
// preflight, arg assembly, readiness wait — executes without a daemon. `logs`
// prints the readiness line immediately, so the wait loop never sleeps.
const DOCKER_STUB = `#!/usr/bin/env bash
case "$1" in
  run) shift; printf '%s\\n' "$@" > "$DOCKER_STUB_ARGS_FILE"; { printf '%s\\n' "$@"; echo ---; } >> "$DOCKER_STUB_ARGS_FILE.all"; echo cid ;;
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

  it("lets an env file own the origin when the shell is silent", async () => {
    const envFile = await writeEnvFile("PANTHEON_BASE_ORIGIN=https://from-file.example\n");
    const args = await runQuickstart({}, ["--env-file", envFile]);
    // No -e flag at all: docker gives -e precedence over --env-file, so the
    // default must stand aside for the env file to be honored.
    expect(args.filter((a) => a.startsWith("PANTHEON_BASE_ORIGIN="))).toEqual([]);
    expect(args).toContain("--env-file");
  });

  it("forwards shell overrides verbatim, over an env-file pin", async () => {
    const envFile = await writeEnvFile(
      "PANTHEON_BASE_ORIGIN=https://from-file.example\n" +
        "ROME_LOOPBACK_CALLBACK_ORIGIN=http://from-file.example\n",
    );
    const args = await runQuickstart(
      {
        PANTHEON_BASE_ORIGIN: "https://from-shell.example",
        ROME_LOOPBACK_CALLBACK_ORIGIN: "http://127.0.0.1:4444",
      },
      ["--env-file", envFile],
    );
    expect(args).toContain("PANTHEON_BASE_ORIGIN=https://from-shell.example");
    expect(args).toContain("ROME_LOOPBACK_CALLBACK_ORIGIN=http://127.0.0.1:4444");
  });

  it("forwards an exported-empty origin as an explicit empty (cloud off), over an env-file pin", async () => {
    const envFile = await writeEnvFile("PANTHEON_BASE_ORIGIN=https://from-file.example\n");
    const args = await runQuickstart({ PANTHEON_BASE_ORIGIN: "" }, ["--env-file", envFile]);
    expect(args).toContain("PANTHEON_BASE_ORIGIN=");
  });

  async function runsOf(): Promise<string[][]> {
    const all = await readFile(`${argsFile}.all`, "utf8");
    return all
      .split("---\n")
      .filter(Boolean)
      .map((run) => run.split("\n").filter(Boolean));
  }

  it("starts the signer before Rome, with the resolved origin as its audience", async () => {
    await runQuickstart({ PANTHEON_BASE_ORIGIN: "https://from-shell.example" });
    const [signer, rome] = await runsOf();
    expect(signer.slice(0, 4)).toEqual(["-d", "--name", "rome-signer", "--restart"]);
    for (const flag of ["--read-only", "--cap-drop", "ALL", "--network", "none"]) {
      expect(signer).toContain(flag);
    }
    expect(signer).toContain("10001:10001");
    expect(signer).toContain("no-new-privileges:true");
    expect(signer).toContain("SIGNER_AUDIENCE=https://from-shell.example");
    expect(signer).toContain("SIGNER_KEY_DIR=/keys");
    expect(signer).toContain("SIGNER_SOCKET=/run/rome-signer/signer.sock");
    expect(signer).toContain("rome-signer-key:/keys");
    expect(signer).toContain("rome-signer-sock:/run/rome-signer");
    expect(signer.slice(-4)).toEqual([
      "--entrypoint",
      "node",
      "yunfanye/rome:latest",
      "/opt/rome/packages/signer/dist/main.js",
    ]);
    expect(rome).toContain("rome-signer-sock:/run/rome-signer:ro");
    expect(rome).toContain("ROME_SIGNER_SOCKET=/run/rome-signer/signer.sock");
    expect(rome).not.toContain("rome-signer-key:/keys");
  });

  it("uses the default origin, and an env file's origin, as the audience", async () => {
    await runQuickstart();
    expect((await runsOf())[0]).toContain("SIGNER_AUDIENCE=https://romeos.cc");
    await rm(`${argsFile}.all`);
    const envFile = await writeEnvFile("PANTHEON_BASE_ORIGIN=https://from-file.example\n");
    await runQuickstart({}, ["--env-file", envFile]);
    expect((await runsOf())[0]).toContain("SIGNER_AUDIENCE=https://from-file.example");
  });

  it("names the signer and its volumes after --name", async () => {
    await runQuickstart({}, ["--name", "work"]);
    const [signer, rome] = await runsOf();
    expect(signer).toContain("work-signer");
    expect(signer).toContain("work-signer-key:/keys");
    expect(signer).toContain("work-signer-sock:/run/rome-signer");
    expect(rome).toContain("work-signer-sock:/run/rome-signer:ro");
  });

  it("starts no signer when Rome Cloud is off", async () => {
    await runQuickstart({ PANTHEON_BASE_ORIGIN: "" });
    const runs = await runsOf();
    expect(runs).toHaveLength(1);
    expect(runs[0].join(" ")).not.toContain("ROME_SIGNER_SOCKET");
  });

  it("derives the callback origin from --port", async () => {
    const args = await runQuickstart({}, ["--port", "9999"]);
    expect(args).toContain("ROME_LOOPBACK_CALLBACK_ORIGIN=http://localhost:9999");
  });
});

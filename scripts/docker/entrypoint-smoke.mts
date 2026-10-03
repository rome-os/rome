#!/usr/bin/env node
// Boot-lifecycle smoke test for docker-entrypoint.sh, run by hand against a
// built image. No CI job runs it.
//
// Usage:
//   node scripts/docker/entrypoint-smoke.mts <image>
//
// To test an entrypoint change without rebuilding the image, copy the working
// tree's entrypoint into a published one:
//   docker build -t rome-entrypoint-smoke -f - . <<'EOF'
//   FROM zoolsher/rome:main
//   COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
//   EOF
//   node scripts/docker/entrypoint-smoke.mts rome-entrypoint-smoke
//
// Each check boots a fresh container with the same privileges docker-compose.yml
// grants the rome service, and removes it afterwards. ROME_SMOKE_RUN_ARGS adds
// whitespace-separated `docker run` flags, for example a CA bundle mount on a
// network that re-terminates TLS. ROME_SMOKE_BOOT_TIMEOUT_S bounds each boot.
//
// Covered: every long-running service listens after boot, `docker stop` finishes
// inside the grace period with exit code 0, a restart reaches "Rome started"
// again without re-syncing /app, and a crashed daemon stops the container with a
// non-zero exit code so a restart policy sees a failure.

import { execFileSync, spawnSync } from "node:child_process";

const image = process.argv[2];
if (!image) {
  console.error("usage: node scripts/docker/entrypoint-smoke.mts <image>");
  process.exit(2);
}

const BOOT_TIMEOUT_MS = Number(process.env.ROME_SMOKE_BOOT_TIMEOUT_S ?? "600") * 1000;
const STOP_GRACE_S = 30;
const EXTRA_RUN_ARGS = (process.env.ROME_SMOKE_RUN_ARGS ?? "").split(/\s+/).filter(Boolean);
const STARTED_MARKER = '"message":"Rome started"';

const SERVICE_PORTS: Record<string, number> = {
  sshd: 22,
  TigerVNC: 5900,
  noVNC: 6080,
  Caddy: 8080,
  "Chrome CDP": 9222,
  "Rome API": 4141,
  "health daemon": 9368,
};

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function dockerStatus(args: string[]): number {
  return spawnSync("docker", args, { stdio: "ignore" }).status ?? -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The container's stdout and stderr, from `since` (an RFC 3339 time) when given. */
function logs(name: string, since?: string): string {
  const args = since ? ["logs", "--since", since, name] : ["logs", name];
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return `${result.stdout}${result.stderr}`;
}

function state(name: string): { running: boolean; exitCode: number } {
  const [running, exitCode] = docker([
    "inspect",
    "-f",
    "{{.State.Running}} {{.State.ExitCode}}",
    name,
  ]).split(" ");
  return { running: running === "true", exitCode: Number(exitCode) };
}

class SmokeFailure extends Error {}

function fail(name: string, message: string): never {
  const tail = logs(name).split("\n").slice(-80).join("\n");
  throw new SmokeFailure(`${message}\n--- last log lines of ${name} ---\n${tail}`);
}

function startContainer(name: string): void {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--cap-add",
    "SYS_ADMIN",
    "--shm-size",
    "1g",
    "--security-opt",
    "apparmor=unconfined",
    ...EXTRA_RUN_ARGS,
    image,
  ]);
}

/** Resolves once the log holds `count` "Rome started" lines. Fails if the container exits first. */
async function waitForStarted(name: string, count: number): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (logs(name).split(STARTED_MARKER).length - 1 >= count) return;
    if (!state(name).running) fail(name, `container exited before "Rome started" (boot ${count})`);
    await sleep(2000);
  }
  fail(name, `no "Rome started" within ${BOOT_TIMEOUT_MS / 1000}s (boot ${count})`);
}

function assertServicesListening(name: string): void {
  const closed = Object.entries(SERVICE_PORTS).filter(
    ([, port]) =>
      dockerStatus(["exec", name, "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`]) !== 0,
  );
  if (closed.length > 0) {
    fail(
      name,
      `not listening: ${closed.map(([service, port]) => `${service} :${port}`).join(", ")}`,
    );
  }
  if (dockerStatus(["exec", name, "curl", "-sf", "http://127.0.0.1:9368/health"]) !== 0) {
    fail(name, "health daemon /health did not return 2xx");
  }
}

/** Stops the container and returns the elapsed seconds. Fails when Docker had to SIGKILL. */
function stopGracefully(name: string): number {
  const startedAt = Date.now();
  docker(["stop", "-t", String(STOP_GRACE_S), name]);
  const elapsedS = (Date.now() - startedAt) / 1000;
  // Docker escalates to SIGKILL at the grace period, so finishing near it
  // means the entrypoint ignored SIGTERM rather than shut down.
  if (elapsedS >= STOP_GRACE_S - 2)
    fail(name, `docker stop took ${elapsedS.toFixed(1)}s, so Docker had to SIGKILL`);
  return elapsedS;
}

async function checkBootStopRestart(name: string): Promise<void> {
  startContainer(name);
  await waitForStarted(name, 1);
  assertServicesListening(name);
  console.log("  boot: every service listening");

  const elapsedS = stopGracefully(name);
  const { exitCode } = state(name);
  if (exitCode !== 0) fail(name, `graceful stop exited with ${exitCode}, expected 0`);
  console.log(`  stop: exit 0 in ${elapsedS.toFixed(1)}s`);

  const restartedAt = new Date().toISOString();
  docker(["start", name]);
  await waitForStarted(name, 2);
  if (!logs(name, restartedAt).includes("Application already synced for this image")) {
    fail(name, "restart re-synced /app although the image did not change");
  }
  assertServicesListening(name);
  console.log("  restart: every service listening, /app sync skipped");
}

async function checkDaemonCrashFailsContainer(name: string): Promise<void> {
  startContainer(name);
  await waitForStarted(name, 1);
  docker(["exec", name, "pkill", "-KILL", "-f", "^node .*/daemon/index\\.(js|ts)"]);

  const deadline = Date.now() + STOP_GRACE_S * 1000;
  while (state(name).running) {
    if (Date.now() > deadline) fail(name, "container still running after its daemon was killed");
    await sleep(1000);
  }
  const { exitCode } = state(name);
  if (exitCode === 0)
    fail(name, "container exited 0 after its daemon crashed, so a restart policy reads success");
  console.log(`  daemon crash: container exited ${exitCode}`);
}

const checks: [string, (name: string) => Promise<void>][] = [
  ["boot, stop, and restart", checkBootStopRestart],
  ["daemon crash fails the container", checkDaemonCrashFailsContainer],
];

let failed = 0;
for (const [index, [label, check]] of checks.entries()) {
  const name = `rome-entrypoint-smoke-${process.pid}-${index}`;
  console.log(`▶ ${label}`);
  try {
    await check(name);
    console.log(`✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${label}\n${error instanceof SmokeFailure ? error.message : String(error)}`);
  } finally {
    dockerStatus(["rm", "-f", "-v", name]);
  }
}

if (failed > 0) {
  console.error(`${failed} of ${checks.length} entrypoint smoke checks failed`);
  process.exit(1);
}
console.log(`all ${checks.length} entrypoint smoke checks passed`);

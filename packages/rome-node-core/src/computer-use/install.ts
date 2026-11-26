import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import manifest from "../../package.json" with { type: "json" };
import { APP_NAME, EXECUTABLE, RELEASE_SIGNING_REQUIREMENT, untilAbort } from "./launch.js";

const ARCHIVE = "Rome-Computer-Use-darwin-arm64.zip";
const RELEASES = "https://github.com/rome-os/rome/releases/download";
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const run = promisify(execFile);

async function runCommand(file: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const command = run(file, args, { signal, killSignal: "SIGKILL" });
  const closed = new Promise<void>((resolve) => command.child.once("close", resolve));
  try {
    return (await command).stdout;
  } finally {
    await closed;
  }
}

interface InstallDeps {
  fetch?: typeof fetch;
  run?: typeof runCommand;
  home?: string;
  temp?: string;
  timeoutMs?: number;
  version?: string;
}

async function download(
  url: URL,
  limit: number,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  for (let hops = 0; ; hops++) {
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("The Helper download requires an HTTPS URL without credentials.");
    const response = await request(url, { redirect: "manual", credentials: "omit", signal });
    if (response.status !== 200 || !response.body) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || !location || hops === 5)
        throw new Error(`The Helper download failed (HTTP ${response.status}).`);
      url = new URL(location, url);
      continue;
    }

    const reader = response.body.getReader();
    try {
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
        throw new Error("The Helper download exceeds its size limit.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await untilAbort(() => reader.read(), signal);
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > limit) throw new Error("The Helper download exceeds its size limit.");
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

async function verifyApp(app: string, command: typeof runCommand, signal: AbortSignal) {
  const executable = join(app, EXECUTABLE);
  for (const directory of [app, join(app, "Contents"), join(app, "Contents", "MacOS")]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Unsafe Helper bundle.");
  }
  if (!(await lstat(executable)).isFile()) throw new Error("Missing Helper executable.");
  await access(executable, constants.X_OK);
  await command(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", `-R=${RELEASE_SIGNING_REQUIREMENT}`, app],
    signal,
  );
  await command("/usr/bin/xcrun", ["stapler", "validate", app], signal);
}

async function checkedApplications(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new Error("Unsafe ~/Applications directory.");
  return info;
}

// RENAME_EXCL also protects an empty destination directory, which rename() can replace.
const RENAME_EXCLUSIVE = `function run(args) {
  ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
  return $.renamex_np(args[0], args[1], 4);
}`;

async function installApp(
  extracted: string,
  applications: string,
  command: typeof runCommand,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await mkdir(applications, { mode: 0o700 }).catch((cause) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  const parent = await checkedApplications(applications);
  const destination = join(applications, APP_NAME);
  const staging = await mkdtemp(join(applications, ".rome-computer-use-"));
  try {
    const candidate = join(staging, APP_NAME);
    await command("/usr/bin/ditto", [extracted, candidate], signal);
    await verifyApp(candidate, command, signal);
    const current = await checkedApplications(applications);
    if (current.dev !== parent.dev || current.ino !== parent.ino)
      throw new Error("The ~/Applications directory changed during installation.");
    const result = await command(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", RENAME_EXCLUSIVE, candidate, destination],
      signal,
    );
    if (result.trim() !== "0") await verifyApp(destination, command, signal);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installHelper(cancel: AbortSignal, deps: InstallDeps = {}): Promise<string> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(deps.timeoutMs ?? 60_000)]);
  signal.throwIfAborted();
  const version: unknown = deps.version ?? manifest.version;
  if (typeof version !== "string" || version.match(SEMVER)?.[0] !== version)
    throw new Error("Invalid @rome-os/node-core release version.");

  const url = `${RELEASES}/node-core-v${version}/${ARCHIVE}`;
  const request = deps.fetch ?? fetch;
  const checksum = (await download(new URL(`${url}.sha256`), 1024, request, signal)).toString(
    "utf8",
  );
  const digest = checksum.slice(0, 64);
  if (
    !/^[0-9a-fA-F]{64}$/.test(digest) ||
    checksum.slice(64).replace(/\r?\n$/, "") !== `  ${ARCHIVE}`
  )
    throw new Error("Invalid Helper SHA-256 checksum file.");
  const archive = await download(new URL(url), 50 * 1024 * 1024, request, signal);
  if (createHash("sha256").update(archive).digest("hex") !== digest.toLowerCase())
    throw new Error("The Helper archive does not match its SHA-256 checksum.");

  signal.throwIfAborted();
  const scratch = await mkdtemp(join(deps.temp ?? tmpdir(), "rome-computer-use-"));
  try {
    const zip = join(scratch, ARCHIVE);
    const stage = join(scratch, "extracted");
    const app = join(stage, APP_NAME);
    const command = deps.run ?? runCommand;
    await writeFile(zip, archive, { mode: 0o600, signal });
    await mkdir(stage, { mode: 0o700 });
    await command("/usr/bin/ditto", ["-x", "-k", zip, stage], signal);
    await verifyApp(app, command, signal);
    return await installApp(app, join(deps.home ?? homedir(), "Applications"), command, signal);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

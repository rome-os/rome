import { afterEach, beforeEach, expect, rs, test } from "@rstest/core";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { installHelper } from "./install.js";
import { APP_NAME, EXECUTABLE, RELEASE_SIGNING_REQUIREMENT } from "./launch.js";

const asset = "Rome-Computer-Use-darwin-arm64.zip";
const version = "2.3.4-rc.1+build.2";
const release = `https://github.com/rome-os/rome/releases/download/node-core-v${version}/${asset}`;
const payload = Buffer.from("fixture archive for injected ditto");
const native = promisify(execFile);
const it = test.skipIf(process.platform === "win32");
type Command = NonNullable<NonNullable<Parameters<typeof installHelper>[1]>["run"]>;
let home: string;
let temp: string;
let destination: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rome-helper-test-"));
  temp = join(home, "scratch");
  await mkdir(temp);
  destination = join(home, "Applications", APP_NAME);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function checksum(bytes: Uint8Array) {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${asset}\n`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assets(bytes = payload) {
  return rs.fn<typeof fetch>(async (url) => {
    return String(url).endsWith(".sha256")
      ? new Response(checksum(bytes))
      : new Response(new Uint8Array(bytes));
  });
}

async function makeApp(app: string, contents = "fixture") {
  const executable = join(app, EXECUTABLE);
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, contents, { mode: 0o700 });
}

const fakeMac: Command = async (tool, args) => {
  if (tool === "/usr/bin/ditto") {
    const [, , archive, stage] = args as [string, string, string, string];
    expect(args.slice(0, 2)).toEqual(["-x", "-k"]);
    expect(dirname(stage)).toBe(dirname(destination));
    expect((await lstat(stage)).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(archive))).mode & 0o777).toBe(0o700);
    expect((await lstat(archive)).mode & 0o777).toBe(0o600);
    expect(await readFile(archive)).toEqual(payload);
    await makeApp(join(stage, APP_NAME));
  }
};

function install(
  deps: Parameters<typeof installHelper>[1] = {},
  signal = new AbortController().signal,
) {
  return installHelper(signal, { home, temp, version, fetch: assets(), run: fakeMac, ...deps });
}

it("downloads the pinned assets and verifies the staged bundle with macOS codesign alone", async () => {
  const fetch = assets();
  const run = rs.fn(fakeMac);
  await expect(install({ fetch, run })).resolves.toBe(destination);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([`${release}.sha256`, release]);
  for (const [, options] of fetch.mock.calls)
    expect(options).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
  expect(run.mock.calls.map(([tool]) => tool)).toEqual(["/usr/bin/ditto", "/usr/bin/codesign"]);
  const staging = run.mock.calls[0]![1][3]!;
  expect(run).toHaveBeenNthCalledWith(
    2,
    "/usr/bin/codesign",
    verification(join(staging, APP_NAME)),
    expect.any(AbortSignal),
  );
  expect(await readFile(join(destination, EXECUTABLE), "utf8")).toBe("fixture");
  expect(await readdir(temp)).toEqual([]);
  expect(await readdir(dirname(destination))).toEqual([APP_NAME]);
});

function verification(app: string) {
  return [
    "--verify",
    "--deep",
    "--strict",
    "--check-notarization",
    `-R=${RELEASE_SIGNING_REQUIREMENT} and notarized`,
    app,
  ];
}

it.each([
  "",
  "latest",
  "v1.2.3",
  "1.02.3",
  "1.2.3-01",
  "1.2.3\n",
  "1.2.3/other",
])("rejects invalid release version %j before requesting anything", async (version) => {
  const fetch = assets();
  await expect(install({ version, fetch })).rejects.toThrow(
    "Invalid @rome-os/node-core release version",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("follows five relative or cross-origin HTTPS redirects", async () => {
  const fetch = assets();
  fetch.mockResolvedValueOnce(Response.redirect("https://cdn.example/first"));
  for (const path of ["/second", "/third", "/fourth", "/fifth"]) {
    fetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: path } }));
  }
  fetch.mockResolvedValueOnce(new Response(checksum(payload)));
  await expect(install({ fetch })).resolves.toBe(destination);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    `${release}.sha256`,
    "https://cdn.example/first",
    "https://cdn.example/second",
    "https://cdn.example/third",
    "https://cdn.example/fourth",
    "https://cdn.example/fifth",
    release,
  ]);
});

it.each([
  "http://example.test/zip",
  "https://user:secret@example.test/zip",
  "file:///tmp/zip",
])("rejects an unsafe redirect before requesting it", async (location) => {
  const fetch = assets().mockResolvedValueOnce(Response.redirect(location));
  await expect(install({ fetch })).rejects.toThrow("HTTPS URL without credentials");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects a sixth redirect and a missing release", async () => {
  const fetch = rs.fn<typeof globalThis.fetch>(async () =>
    Response.redirect("https://cdn.example/again"),
  );
  await expect(install({ fetch })).rejects.toThrow("HTTP 302");
  expect(fetch).toHaveBeenCalledTimes(6);
  fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(install({ fetch })).rejects.toThrow("HTTP 404");
});

it.each([
  { archive: false, limit: 1024 },
  { archive: true, limit: 50 * 1024 * 1024 },
])("bounds both the declared and streamed size at $limit bytes", async ({ archive, limit }) => {
  const run = rs.fn(fakeMac);
  for (const body of ["length", "stream"]) {
    const response =
      body === "length"
        ? new Response("under limit", { headers: { "Content-Length": String(limit + 1) } })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(limit));
                controller.enqueue(new Uint8Array(1));
                controller.close();
              },
            }),
          );
    const fetch = assets();
    if (archive) fetch.mockResolvedValueOnce(new Response(checksum(payload)));
    fetch.mockResolvedValueOnce(response);
    await expect(install({ fetch, run })).rejects.toThrow("size limit");
  }
  expect(run).not.toHaveBeenCalled();
});

it("rejects an invalid checksum file or mismatched archive before running ditto", async () => {
  const run = rs.fn(fakeMac);
  const fetch = assets().mockResolvedValueOnce(
    new Response(checksum(payload).replace(asset, "another.zip")),
  );
  await expect(install({ fetch, run })).rejects.toThrow("Invalid Helper SHA-256 checksum file");
  fetch.mockResolvedValueOnce(new Response(checksum(Buffer.from("different archive"))));
  await expect(install({ fetch, run })).rejects.toThrow("does not match its SHA-256 checksum");
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(temp)).toEqual([]);
});

it("cleans the archive and staging directory when codesign rejects the Helper", async () => {
  const run: Command = (tool, args, signal) => {
    if (tool === "/usr/bin/codesign") return Promise.reject(new Error("Verification rejected"));
    return fakeMac(tool, args, signal);
  };
  await expect(install({ run })).rejects.toThrow("Verification rejected");
  expect(await readdir(temp)).toEqual([]);
  expect(await readdir(dirname(destination))).toEqual([]);
});

it.each(["bundle", "executable"])("rejects a symlink at the extracted %s", async (kind) => {
  const realApp = join(home, "actual.app");
  await makeApp(realApp);
  const run = rs.fn<Command>(async (_tool, args) => {
    const app = join(args[3]!, APP_NAME);
    if (kind === "bundle") await symlink(realApp, app);
    else {
      const executable = join(app, EXECUTABLE);
      await mkdir(dirname(executable), { recursive: true });
      await symlink(join(realApp, EXECUTABLE), executable);
    }
  });
  await expect(install({ run })).rejects.toThrow(/Unsafe Helper bundle|Missing Helper executable/);
  expect(run).toHaveBeenCalledTimes(1);
  expect(await readdir(temp)).toEqual([]);
});

it("rejects a symlinked Applications directory and leaves its target alone", async () => {
  const other = join(home, "other");
  await mkdir(other);
  await symlink(other, dirname(destination));
  await expect(install()).rejects.toThrow("Unsafe ~/Applications directory");
  expect(await readdir(other)).toEqual([]);
  expect(await readdir(temp)).toEqual([]);
});

it.each([
  "pre-existing",
  "concurrent",
  "invalid",
])("verifies a %s destination after rename collides", async (kind) => {
  if (kind !== "concurrent") await makeApp(destination, "other installer");
  const run = rs.fn<Command>(async (tool, args, signal) => {
    if (tool !== "/usr/bin/codesign") return fakeMac(tool, args, signal);
    if (kind === "concurrent" && args.at(-1) !== destination)
      await makeApp(destination, "other installer");
    if (kind === "invalid" && args.at(-1) === destination) throw new Error("Verification rejected");
  });
  if (kind === "invalid") await expect(install({ run })).rejects.toThrow("Verification rejected");
  else await expect(install({ run })).resolves.toBe(destination);
  expect(run).toHaveBeenNthCalledWith(
    3,
    "/usr/bin/codesign",
    verification(destination),
    expect.any(AbortSignal),
  );
  expect(await readFile(join(destination, EXECUTABLE), "utf8")).toBe("other installer");
  expect(await readdir(temp)).toEqual([]);
  expect(await readdir(dirname(destination))).toEqual([APP_NAME]);
});

it.each(["cancel", "timeout"])("cancels a stalled response body on %s", async (stop) => {
  const controller = new AbortController();
  const canceled = rs.fn();
  const { promise, resolve } = deferred();
  const fetch = assets().mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          pull: () => resolve(),
          cancel: canceled,
        }),
      ),
  );
  const pending = install(
    { fetch, timeoutMs: stop === "timeout" ? 50 : 60_000 },
    controller.signal,
  );
  const failed = expect(pending).rejects.toMatchObject({
    name: stop === "cancel" ? "AbortError" : "TimeoutError",
  });
  await promise;
  if (stop === "cancel") controller.abort();
  await failed;
  expect(canceled).toHaveBeenCalledTimes(1);
  expect(await readdir(temp)).toEqual([]);
});

it("cleans the extraction directory when the extraction command is aborted", async () => {
  const controller = new AbortController();
  const { promise, resolve } = deferred();
  const run: Command = (_tool, _args, signal) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      resolve();
    });
  const pending = install({ run }, controller.signal);
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await promise;
  controller.abort();
  await failed;
  expect(await readdir(temp)).toEqual([]);
  expect(await readdir(dirname(destination))).toEqual([]);
});

test.skipIf(process.platform !== "darwin")(
  "extracts the macOS release ZIP and atomically publishes one executable bundle",
  async () => {
    const fixture = join(home, APP_NAME);
    const zip = join(home, asset);
    await makeApp(fixture);
    await native("/usr/bin/ditto", ["-c", "-k", "--keepParent", fixture, zip]);
    const fetch = assets(await readFile(zip));
    const run = rs.fn<Command>(async (tool, args, signal) => {
      if (tool === "/usr/bin/ditto") await native(tool, args, { signal });
    });
    expect(await Promise.all([install({ fetch, run }), install({ fetch, run })])).toEqual([
      destination,
      destination,
    ]);
    expect(await readFile(join(destination, EXECUTABLE), "utf8")).toBe("fixture");
    expect((await lstat(join(destination, EXECUTABLE))).mode & 0o111).toBe(0o100);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      verification(destination),
      expect.any(AbortSignal),
    );
    expect(await readdir(dirname(destination))).toEqual([APP_NAME]);
    expect(await readdir(temp)).toEqual([]);
  },
);

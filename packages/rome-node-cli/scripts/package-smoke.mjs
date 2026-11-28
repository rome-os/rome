import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packages = fileURLToPath(new URL("../../", import.meta.url));
const helperName = "@rome-os/node-core-darwin-arm64";
const coreName = "@rome-os/node-core";
const cliName = "@rome-os/node";
const app = "dist/native/Rome Computer Use.app";
const binary = `${app}/Contents/MacOS/RomeComputerUse`;
const darwinArm64 = process.platform === "darwin" && process.arch === "arm64";
const { packageManager } = JSON.parse(await readFile(join(packages, "..", "package.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "rome-node-package-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

function pack(folder) {
  const archive = join(directory, `${folder}.tgz`);
  run("pnpm", ["pack", "--out", archive], join(packages, folder));
  return archive;
}

async function checkInstalled(manager, name, archive, overrides) {
  const cwd = join(directory, `${manager}-${name.split("/").at(-1)}`);
  await mkdir(cwd);
  const manifest = join(cwd, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({
      private: true,
      dependencies: { [name]: `file:${archive}` },
      ...(manager === "npm" ? { overrides } : { packageManager }),
    }),
  );
  if (manager === "pnpm") {
    await writeFile(
      join(cwd, "pnpm-workspace.yaml"),
      JSON.stringify({ overrides, minimumReleaseAge: 0 }),
    );
  }
  run(manager, ["install", "--ignore-scripts"], cwd);
  const require = createRequire(manifest);
  const coreRequire = name === cliName ? createRequire(require.resolve(cliName)) : require;
  const hostEntry = coreRequire.resolve("@rome-os/node-core/host");
  const resolveHelper = () => createRequire(hostEntry).resolve(`${helperName}/package.json`);
  if (darwinArm64) {
    const helper = dirname(resolveHelper());
    await access(join(helper, binary), constants.X_OK);
    const { discoverHelper } = await import(
      pathToFileURL(join(dirname(hostEntry), "computer-use/discovery.js"))
    );
    assert.equal(
      await discoverHelper({ envPath: undefined, stagedAppPath: null, applications: [] }),
      join(helper, app),
    );
  } else {
    assert.throws(resolveHelper, { code: "MODULE_NOT_FOUND" });
  }
  if (name === cliName) {
    run(
      process.execPath,
      [join(dirname(dirname(require.resolve(cliName))), "bin/rome-node.js"), "--help"],
      cwd,
    );
  }
  return require;
}

try {
  // npm pack preserves the helper's mode. The CI fixture skips the release signing checks.
  const helperFile = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", directory],
    { cwd: join(packages, "rome-node-core-darwin-arm64"), encoding: "utf8" },
  ).trim();
  const helper = join(directory, helperFile);
  const core = pack("rome-node-core");
  const cli = pack("rome-node-cli");
  const contents = (archive) => execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.ok(contents(helper).split("\n").includes(`package/${binary}`));
  assert.ok(!contents(core).includes("Rome Computer Use.app"));
  assert.ok(!contents(cli).includes("Rome Computer Use.app"));
  const unpacked = join(directory, "unpacked");
  await mkdir(unpacked);
  run("tar", ["-xzf", helper, "-C", unpacked]);
  await access(join(unpacked, "package", binary), constants.X_OK);
  const helperOverride = { [helperName]: `file:${helper}` };
  for (const manager of ["npm", "pnpm"]) {
    const require = await checkInstalled(manager, coreName, core, helperOverride);
    if (manager === "npm") await smokeCaller(require);
    await checkInstalled(manager, cliName, cli, { ...helperOverride, [coreName]: `file:${core}` });
  }
  console.log(`npm and pnpm archive smoke passed on ${process.platform}/${process.arch}.`);
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}

async function smokeCaller(require) {
  assert.throws(() => require.resolve("@rome-os/node"), { code: "MODULE_NOT_FOUND" });
  const { createNodeClient, createNodeConfig, stopDaemon } = await import(
    pathToFileURL(require.resolve("@rome-os/node-core/client")).href
  );
  const { configureCaller } = await import(
    pathToFileURL(require.resolve("@rome-os/node-core/auth")).href
  );
  const directory = await mkdtemp(join(tmpdir(), "rome-node-package-"));
  const config = createNodeConfig({ directory });
  const token = `romedev_${"a".repeat(43)}`;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/gateway/config"
          ? { gatewayUrl: "wss://gateway.example/connect" }
          : { items: [{ id: "target" }] },
      ),
    );
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await configureCaller(`http://127.0.0.1:${address.port}`, token, config);
    const client = createNodeClient(config);
    assert.equal(await client.getConnectionStatus(), null);
    assert.deepEqual(await client.listDevices(), { items: [{ id: "target" }] });
    const status = await client.getConnectionStatus();
    assert.equal(status.connection, "stopped");
    assert.equal(status.protocolVersion, 4);
    assert.notEqual(status.pid, process.pid);
    const events = [];
    const unsubscribe = await client.subscribe("connection", (event) => events.push(event));
    assert.deepEqual(events, [{ transport: "connected", daemon: status }]);
    await unsubscribe();
    client.disconnect();
    const other = createNodeClient(config);
    assert.deepEqual(await other.getConnectionStatus(), status);
    other.disconnect();
    console.log(
      "Core archive starts, shares, and subscribes to its daemon without the CLI package.",
    );
  } finally {
    await stopDaemon(config);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch((error) => {
      // A stopped daemon can hold observe.db open a little longer, and Windows refuses to remove
      // an open file. A leftover temporary directory is harmless there.
      if (process.platform !== "win32") throw error;
    });
  }
}

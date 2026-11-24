import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve(process.argv[2], "package.json"));
assert.throws(() => require.resolve("@rome-os/node"), { code: "MODULE_NOT_FOUND" });
const computerUseEntry = require.resolve("@rome-os/node-core/computer-use");
assert.equal(
  await stat(resolve(dirname(computerUseEntry), "native")).catch(() => null),
  null,
  "@rome-os/node-core must not embed the macOS native helper directly.",
);
const { createComputerUseHost } = await import(pathToFileURL(computerUseEntry).href);
const capability = await createComputerUseHost().describe();
assert.equal(capability.prefix, "computer");
assert.equal(capability.personal, true);
const coreRequire = createRequire(computerUseEntry);
if (process.platform === "darwin" && process.arch === "arm64") {
  const nativePackage = coreRequire.resolve("@rome-os/node-core-darwin-arm64/package.json");
  const helperApp = resolve(dirname(nativePackage), "dist/native/Rome Computer Use.app");
  const helper = resolve(helperApp, "Contents/MacOS/RomeComputerUse");
  assert.ok((await stat(helper)).isFile(), "The darwin-arm64 package must contain the helper.");
  const helperBytes = await readFile(helper);
  assert.equal(helperBytes.readUInt32LE(0), 0xfeedfacf);
  assert.equal(helperBytes.readUInt32LE(4), 0x0100000c);
  assert.equal(capability.configured, true);
  const helperInfo = await readFile(resolve(helperApp, "Contents/Info.plist"), "utf8");
  if (!/<key>RomeComputerUseUnsigned<\/key>\s*<true\/>/.test(helperInfo)) {
    const runtime = await mkdtemp("/tmp/rome-cua-archive-");
    try {
      const { inspectComputerUseApp, prepareComputerUseApp } = await import(
        pathToFileURL(resolve(dirname(computerUseEntry), "computer-use/native-assets.js")).href
      );
      const source = await inspectComputerUseApp(helperApp);
      const prepared = await prepareComputerUseApp(source, runtime);
      assert.equal(
        (await stat(resolve(prepared.path, "Contents/MacOS/RomeComputerUse"))).mode & 0o111,
        0o111,
      );
      assert.equal(prepared.executableSha256, source.executableSha256);
      assert.equal(prepared.requirement, source.requirement);
      console.log(
        "The installed signed helper restores executable mode through its locked staging entry.",
      );
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  }
} else {
  assert.throws(() => coreRequire.resolve("@rome-os/node-core-darwin-arm64/package.json"), {
    code: "MODULE_NOT_FOUND",
  });
  assert.equal(capability.configured, false);
  console.log("Non-darwin/arm64 install skipped @rome-os/node-core-darwin-arm64 as expected.");
}
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
  console.log("Core archive starts, shares, and subscribes to its daemon without the CLI package.");
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

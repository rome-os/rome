import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve(process.argv[2], "package.json"));
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
  assert.equal(status.protocolVersion, 2);
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
  await rm(directory, { recursive: true, force: true });
}

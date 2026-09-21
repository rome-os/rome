import { afterEach, expect, it } from "@rstest/core";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeConfig, startDaemon, stopDaemon } from "./daemon-client.js";
import { writePrivateJson } from "./storage.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

it("retries an exited launcher while the previous listener releases its port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rome-node-restart-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const previous = createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((resolve) => previous.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => previous.close(() => resolve())));
  const address = previous.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const config = createNodeConfig({ directory, port: address.port });
  await writePrivateJson(join(directory, "caller.json"), {
    cloudUrl: "https://cloud.example",
    token: `romedev_${"a".repeat(43)}`,
  });
  await writePrivateJson(join(directory, "daemon.json"), {
    pid: process.pid,
    port: config.port,
    protocolVersion: 2,
    token: `romenode_${"a".repeat(43)}`,
  });
  cleanup.push(() => stopDaemon(config));
  const release = setTimeout(() => previous.close(), 1500);
  cleanup.push(async () => clearTimeout(release));
  const status = await startDaemon(config);
  expect(status.connection).toBe("stopped");
  expect(status.pid).not.toBe(process.pid);
}, 15_000);

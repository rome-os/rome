import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startMockServer } from "../mock-server.ts";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const close = (server) => new Promise((resolve) => server.close(resolve));

test("reuses an existing server without shutting it down", async () => {
  const server = createServer((_, response) => response.end("ready"));
  const url = await listen(server);
  try {
    const stop = await startMockServer(url);
    await stop();
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await close(server);
  }
});

test("starts an isolated server and stops it idempotently", async () => {
  const probe = createServer();
  const url = await listen(probe);
  await close(probe);
  const directory = await mkdtemp(path.join(tmpdir(), "rome-mock-start-"));
  const originalPath = process.env.PATH;
  const originalKey = process.env.MIDSCENE_MODEL_API_KEY;
  await writeFile(path.join(directory, "pnpm"), `#!${process.execPath}
const http = require('node:http');
if (process.env.MIDSCENE_MODEL_API_KEY) process.exit(2);
http.createServer((_, res) => res.end('ready')).listen(Number(process.env.MOCK_WEB_PORT), '127.0.0.1');
`, { mode: 0o755 });
  process.env.PATH = `${directory}:${originalPath}`;
  process.env.MIDSCENE_MODEL_API_KEY = "test-secret";
  let stop;
  try {
    stop = await startMockServer(url);
    assert.equal(await (await fetch(url)).text(), "ready");
    await stop();
    await stop();
    await assert.rejects(fetch(url));
  } finally {
    await stop?.();
    process.env.PATH = originalPath;
    if (originalKey === undefined) delete process.env.MIDSCENE_MODEL_API_KEY;
    else process.env.MIDSCENE_MODEL_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects startup failure and removes signal handlers", async () => {
  const probe = createServer();
  const url = await listen(probe);
  await close(probe);
  const directory = await mkdtemp(path.join(tmpdir(), "rome-mock-fail-"));
  const originalPath = process.env.PATH;
  const handlers = process.listenerCount("SIGTERM");
  await writeFile(path.join(directory, "pnpm"), `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 });
  process.env.PATH = directory;
  try {
    await assert.rejects(startMockServer(url), /exited before readiness/);
    assert.equal(process.listenerCount("SIGTERM"), handlers);
    await assert.rejects(fetch(url));
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

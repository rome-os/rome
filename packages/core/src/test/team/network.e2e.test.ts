// The team verifier's instance reaches no server on the developer's machine
// that the verifier did not start, and runs no program but the sandbox's
// stubs. `POST /api/desktop/navigate-chatgpt` calls Chrome's debugging port to
// close tabs and open new ones; a fake Chrome on a loopback port stands in for
// it. The desktop routes read the port once at load, so this file sets it
// before it loads the instance.

// First, so HOME is the sandbox's before any product module loads.
import { refusedLaunches, SANDBOX } from "./sandbox.js";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";

let chrome: Server;
let chromePort = 0;
const chromeRequests: string[] = [];
const savedPort = process.env.ROME_CHROME_CDP_PORT;

beforeAll(async () => {
  chrome = createServer((req, res) => {
    chromeRequests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  });
  await new Promise<void>((resolve) => chrome.listen(0, "127.0.0.1", resolve));
  const address = chrome.address();
  if (!address || typeof address === "string") throw new Error("the fake Chrome has no port");
  chromePort = address.port;
  process.env.ROME_CHROME_CDP_PORT = String(chromePort);
});

afterAll(async () => {
  if (savedPort === undefined) delete process.env.ROME_CHROME_CDP_PORT;
  else process.env.ROME_CHROME_CDP_PORT = savedPort;
  await new Promise<void>((resolve) => chrome.close(() => resolve()));
});

async function navigateChatGpt(allowChrome: boolean): Promise<number> {
  const { createInstance } = await import("./instance.js");
  const { browse, cookieOf } = await import("./callers.js");
  const { allowVerifierServer } = await import("./network.js");
  const instance = await createInstance({ dashboardEmails: [] });
  const disallow = allowChrome ? allowVerifierServer(chromePort) : () => {};
  try {
    const { response } = await browse(instance.app, {
      method: "POST",
      path: "/api/desktop/navigate-chatgpt",
      cookie: cookieOf("guardian"),
    });
    return response.status;
  } finally {
    disallow();
    await instance.close();
  }
}

describe("the team verifier's instance", () => {
  it("never reaches a loopback server the verifier did not start", async () => {
    chromeRequests.length = 0;
    expect(await navigateChatGpt(false)).toBe(503);
    expect(chromeRequests).toEqual([]);
  }, 60_000);

  it("reaches that server once the verifier allows its port", async () => {
    chromeRequests.length = 0;
    expect(await navigateChatGpt(true)).toBe(200);
    expect(chromeRequests).toContain("GET /json/list");
  }, 60_000);
});

describe("a program a route launches", () => {
  // A program outside the sandbox that would leave a file behind if it ran.
  const outside = mkdtempSync(join(SANDBOX.home, "outside-"));
  const ranMarker = join(outside, "ran");
  const decoy = join(outside, "composio");
  writeFileSync(decoy, `#!/bin/sh\ntouch '${ranMarker}'\n`);
  chmodSync(decoy, 0o755);

  async function withInstance<T>(run: () => Promise<T>): Promise<T> {
    const { createInstance } = await import("./instance.js");
    const instance = await createInstance({ dashboardEmails: [] });
    try {
      return await run();
    } finally {
      await instance.close();
    }
  }

  it("is refused when it lies outside the sandbox's stubs", async () => {
    const before = refusedLaunches().length;
    const sync = await withInstance(async () => spawnSync(decoy, ["login"]));
    expect(sync.status).toBe(127);
    const viaExecFile = await withInstance(() =>
      promisify(execFile)(decoy, ["login"]).then(
        () => 0,
        (error: { code?: number }) => error.code,
      ),
    );
    expect(viaExecFile).toBe(127);
    expect(existsSync(ranMarker)).toBe(false);
    expect(refusedLaunches().slice(before)).toEqual([`${decoy} login`, `${decoy} login`]);
  }, 60_000);

  it("runs the sandbox's stub for a CLI it has one for, whatever PATH comes first", async () => {
    // The Composio CLI's own directories go ahead of PATH, as
    // `getComposioEnv` puts them.
    const result = await withInstance(async () =>
      spawnSync("composio", ["login"], { env: { PATH: `${outside}:${process.env.PATH}` } }),
    );
    expect(result.status).toBe(1);
    expect(existsSync(ranMarker)).toBe(false);
  }, 60_000);
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { type RunTarget, serve } from "./server.js";

describe("serve", () => {
  let traces: string;
  let ui: ReturnType<typeof serve>;
  let base: string;
  const runs: RunTarget[] = [];

  beforeEach(async () => {
    traces = await mkdtemp(join(tmpdir(), "channel-ui-"));
    runs.length = 0;
    ui = serve({
      traces,
      web: join(traces, "web"),
      port: 0,
      // A run that lasts long enough for a second request to find it running.
      command: (target) => {
        runs.push(target);
        return {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 300)"],
          cwd: traces,
        };
      },
    });
    await once(ui.server, "listening");
    base = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    ui.close();
    await rm(traces, { recursive: true, force: true });
  });

  it("answers null before any run has written an index", async () => {
    expect(await (await fetch(`${base}/api/index`)).json()).toBeNull();
  });

  it("serves a trace under the traces directory and nothing outside it", async () => {
    await writeFile(join(traces, "t.json"), '{"ok":true}');

    expect(await (await fetch(`${base}/api/trace?path=t.json`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/api/trace?path=../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/trace?path=${encodeURIComponent("/etc/hosts")}`)).status).toBe(
      404,
    );
  });

  it("runs the tests named and refuses a second run while one is in progress", async () => {
    const run = (body: unknown) =>
      fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await run({ names: ["a > b"] })).status).toBe(202);
    expect((await run({})).status).toBe(409);
    expect(runs).toEqual([{ names: ["a > b"] }]);
  });

  it("starts no run for a request that is not JSON, as a cross-site form would send", async () => {
    const response = await fetch(`${base}/api/run`, { method: "POST", body: "{}" });

    expect(response.status).toBe(415);
    expect(runs).toEqual([]);
  });
});

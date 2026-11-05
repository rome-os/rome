import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureSignerCaller } from "./auth.js";
import { callerToken, createNodeConfig, readOptionalCallerCredential } from "./local.js";
import { writePrivateJson } from "./storage.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { force: true, recursive: true });
});

async function config() {
  const directory = await mkdtemp(join(tmpdir(), "rome-node-caller-"));
  directories.push(directory);
  return createNodeConfig({ directory, port: 45678 });
}

describe("caller.json", () => {
  it("writes version 2 with the signer socket and no secret", async () => {
    const node = await config();
    await configureSignerCaller("https://cloud.example", "/run/rome-signer/signer.sock", node);
    const path = join(node.directory, "caller.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 2,
      cloudUrl: "https://cloud.example",
      signerSocket: "/run/rome-signer/signer.sock",
    });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readOptionalCallerCredential(node)).toEqual({
      cloudUrl: "https://cloud.example",
      signerSocket: "/run/rome-signer/signer.sock",
    });
  });

  it("replaces a version 1 file when the signer is configured", async () => {
    const node = await config();
    await writePrivateJson(join(node.directory, "caller.json"), {
      cloudUrl: "https://cloud.example",
      token: `romedev_${"a".repeat(43)}`,
    });
    await configureSignerCaller("https://cloud.example", "/run/signer.sock", node);
    expect((await readOptionalCallerCredential(node))?.token).toBeUndefined();
  });

  it("still reads a version 1 file and returns its fixed token", async () => {
    const node = await config();
    const token = `romedev_${"a".repeat(43)}`;
    await writePrivateJson(join(node.directory, "caller.json"), {
      cloudUrl: "https://cloud.example",
      token,
    });
    const credential = await readOptionalCallerCredential(node);
    expect(credential).toEqual({ cloudUrl: "https://cloud.example", token });
    expect(await callerToken(credential!)()).toBe(token);
  });

  it("rejects a version 2 file without an absolute socket path", async () => {
    const node = await config();
    await writePrivateJson(join(node.directory, "caller.json"), {
      version: 2,
      cloudUrl: "https://cloud.example",
      signerSocket: "signer.sock",
    });
    expect(await readOptionalCallerCredential(node)).toBeNull();
  });
});

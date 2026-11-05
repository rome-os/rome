import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJwt, requestSignerToken, SignerError, signerHealth } from "./signer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fakeSigner(handler: Parameters<typeof createServer>[1]) {
  const dir = await mkdtemp(join(tmpdir(), "rome-signer-client-"));
  const socketPath = join(dir, "signer.sock");
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}

describe("signer client", () => {
  it("requests a token with POST /v1/token each time", async () => {
    let calls = 0;
    const socketPath = await fakeSigner((req, res) => {
      expect(`${req.method} ${req.url}`).toBe("POST /v1/token");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ token: `eyJ${++calls}.e30.sig` }));
    });
    expect(await requestSignerToken(socketPath)).toBe("eyJ1.e30.sig");
    expect(await requestSignerToken(socketPath)).toBe("eyJ2.e30.sig");
  });

  it("reads the key thumbprint and audience from /v1/health", async () => {
    const socketPath = await fakeSigner((_req, res) =>
      res.end(JSON.stringify({ ok: true, jkt: "abc", aud: "https://cloud.example" })),
    );
    expect(await signerHealth(socketPath)).toEqual({
      jkt: "abc",
      aud: "https://cloud.example",
    });
  });

  it("reports an unreachable signer, a rate limit, and a malformed token", async () => {
    await expect(requestSignerToken("/nonexistent/signer.sock")).rejects.toMatchObject({
      code: "signer_unavailable",
    });
    const limited = await fakeSigner((_req, res) => res.writeHead(429).end("{}"));
    await expect(requestSignerToken(limited)).rejects.toMatchObject({ code: "rate_limited" });
    const bad = await fakeSigner((_req, res) => res.end(JSON.stringify({ token: "romeinst_x" })));
    await expect(requestSignerToken(bad)).rejects.toBeInstanceOf(SignerError);
  });

  it("recognizes the JWT shape within the size limit", () => {
    expect(isJwt("a.b.c")).toBe(true);
    expect(isJwt("a.b")).toBe(false);
    expect(isJwt(`romedev_${"a".repeat(43)}`)).toBe(false);
    expect(isJwt(`a.${"b".repeat(2048)}.c`)).toBe(false);
  });
});

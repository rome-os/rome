import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A signer on a real unix socket. Each token is a distinct JWT-shaped string
 * whose payload carries `exp`, and `health.aud` is the origin it claims to serve.
 */
export async function startFakeSigner(options: { aud: string; lifetimeSeconds?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "rome-fake-signer-"));
  const socketPath = join(directory, "signer.sock");
  const state = {
    aud: options.aud,
    lifetimeSeconds: options.lifetimeSeconds ?? 60,
    issued: 0,
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") {
      res.end(JSON.stringify({ ok: true, jkt: "jkt-1", aud: state.aud }));
      return;
    }
    const payload = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + state.lifetimeSeconds,
        n: ++state.issued,
      }),
    ).toString("base64url");
    res.end(JSON.stringify({ token: `eyJhbGciOiJFUzI1NiJ9.${payload}.sig` }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    state,
    async close() {
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

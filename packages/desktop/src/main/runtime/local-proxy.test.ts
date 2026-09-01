import { request as httpRequest } from "http";
import { createServer, type Server } from "net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";

// Not decoration: logger.ts mkdirSyncs ~/.rome-desktop and opens a winston File
// transport at module load. Unmocked, this test writes to the user's real
// debug.log and holds a handle to it. The refusal tests also assert on this
// mock — a closed socket looks the same whether the guard rejected the upgrade
// or the forward to a dead socket failed, so the log line is what tells them
// apart.
const logWarn = rs.hoisted(() => rs.fn());
rs.mock("../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: logWarn }),
}));

import { startLocalProxy, type LocalProxy } from "./local-proxy";

const SOCKET_PATH = "/tmp/rome-local-proxy-test.sock";

/**
 * Ask the OS for a free port, then release it. There is an unavoidable gap
 * between releasing and rebinding, so this narrows the odds of a collision
 * rather than removing them — it is only used where the test needs a port that
 * is free. The conflict test below needs a port that is *taken*, which can be
 * arranged with no gap at all.
 */
async function borrowFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = portOf(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server is not listening on a TCP port");
  }
  return address.port;
}

describe("startLocalProxy port binding", () => {
  const openProxies: LocalProxy[] = [];
  const openServers: Server[] = [];

  afterEach(async () => {
    logWarn.mockClear();
    for (const proxy of openProxies.splice(0)) await proxy.close();
    for (const server of openServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("binds the requested port so the origin is stable across launches", async () => {
    // `port` is required — there is no ephemeral default to fall back to. A
    // caller that omitted it would silently restore random ports and break both
    // the OAuth callback origin and localStorage stability again.
    const port = await borrowFreePort();
    const proxy = await startLocalProxy(SOCKET_PATH, port);
    openProxies.push(proxy);
    expect(proxy.url).toBe(`http://127.0.0.1:${port}`);
  });

  it("rejects rather than silently falling back when the port is taken", async () => {
    // A fallback port would land in the runtime env file, change its hash, and
    // force a full container recreate on every launch — worse than failing.
    //
    // The squatter binds an OS-assigned port and keeps it, so the port is known
    // to be occupied at the moment startLocalProxy tries for it. Asking for a
    // free port and re-binding it here would leave a window for someone else to
    // take it, turning a real failure into a confusing one.
    const squatter = createServer();
    openServers.push(squatter);
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(0, "127.0.0.1", resolve);
    });
    const port = portOf(squatter);

    await expect(startLocalProxy(SOCKET_PATH, port)).rejects.toThrow(String(port));
  });

  it("refuses a request addressed to another host", async () => {
    // DNS rebinding is the case SameSite=Lax does not cover: the request
    // arrives without credentials but reaches the loopback service anyway. It
    // carries the attacker's hostname, so comparing Host to the address we
    // bound is what stops it.
    const port = await borrowFreePort();
    const proxy = await startLocalProxy(SOCKET_PATH, port);
    openProxies.push(proxy);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(403);
  });

  it.each([
    ["a hostile page", "https://evil.example"],
    ["no origin at all", undefined],
  ])("refuses a websocket upgrade from %s", async (_label, origin) => {
    // WebSocket ignores the same-origin policy, so any page can open one at
    // this port, and Host cannot tell them apart — the attacker's target IS
    // this address. The upstream /ws/* endpoints are unauthenticated (Caddy
    // routes them past forward_auth), so there is no cookie to withhold
    // either. Origin is the only separation.
    const port = await borrowFreePort();
    const proxy = await startLocalProxy(SOCKET_PATH, port);
    openProxies.push(proxy);

    const headers: Record<string, string> = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    if (origin) headers.origin = origin;

    const closedWithoutResponse = await new Promise<boolean>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/ws/terminal", headers });
      req.on("upgrade", () => resolve(false));
      req.on("response", () => resolve(false));
      // The guard destroys the socket, so the request ends without either.
      req.on("error", () => resolve(true));
      req.on("close", () => resolve(true));
      req.end();
      setTimeout(() => reject(new Error("upgrade neither completed nor closed")), 5000);
    });

    expect(closedWithoutResponse).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("refusing upgrade from origin"));
  });

  it("lets a websocket upgrade from its own origin through to the upstream", async () => {
    // The counterpart to the refusals above: same request, correct Origin, and
    // the guard must not be what ends it. Reaching the upstream is enough —
    // the socket has no listener here, so it fails past the guard, not at it.
    const port = await borrowFreePort();
    const proxy = await startLocalProxy(SOCKET_PATH, port);
    openProxies.push(proxy);

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/ws/terminal",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          origin: `http://127.0.0.1:${port}`,
        },
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.on("upgrade", () => resolve());
      req.end();
      setTimeout(() => reject(new Error("request never settled")), 5000);
    });

    expect(logWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("refusing upgrade from origin"),
    );
  });

  it("forwards a request addressed to the proxy itself", async () => {
    // The socket has no listener in this test, so reaching the upstream is
    // proof enough that the guard let it through: 502 comes from the forward
    // failing, not from the Host check.
    const port = await borrowFreePort();
    const proxy = await startLocalProxy(SOCKET_PATH, port);
    openProxies.push(proxy);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/health" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(502);
  });
});

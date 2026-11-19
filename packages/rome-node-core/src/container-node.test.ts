import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, rs } from "@rstest/core";
import { WebSocketServer } from "ws";
import { encodeMeta, FRAME_TYPE } from "./frame.js";
import { runContainerNode } from "./container-node.js";
import { CONTAINER_NODE_SOCKET_PATH } from "./container-node-address.js";
import { createContainerNodeResponder } from "./container-node-responder.js";
import type { OutboundEnvelope } from "./protocol.js";

const installationId = "900bacd6-9988-4f9a-81ff-da8282621806";
const callerId = "96467432-4ead-4cd2-bf84-2504bed44729";
const first = {
  grant: `romeinstall_${"A".repeat(43)}`,
  token: `romedev_${"B".repeat(43)}`,
  id: randomUUID(),
};
const second = {
  grant: `romeinstall_${"C".repeat(43)}`,
  token: `romedev_${"D".repeat(43)}`,
  id: randomUUID(),
};

afterEach(() => {
  rs.restoreAllMocks();
});

it.each([
  {
    code: "ENOTFOUND",
    respond: async () => {
      throw new TypeError(first.grant, { cause: { code: "ENOTFOUND", message: first.token } });
    },
  },
  {
    code: "HTTP_503",
    respond: async () => new Response(first.token, { status: 503 }),
  },
])("reports $code when pairing retries without exposing the response or error text", async ({
  code,
  respond,
}) => {
  const stateDir = await mkdtemp(join(tmpdir(), "container-node-retry-"));
  const stop = new AbortController();
  const report = rs.fn();
  rs.spyOn(globalThis, "fetch").mockImplementation(respond);
  try {
    const result = await runContainerNode({
      cloudUrl: "https://rome.example",
      installationId,
      installToken: first.grant,
      stateDir,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(2000)]),
      onEvent(event) {
        if (event.type !== "pairing_retry") return;
        report(event);
        stop.abort();
      },
    });
    expect(result).toBe("stopped");
    expect(report).toHaveBeenCalledExactlyOnceWith({ type: "pairing_retry", code });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it("performs one bounded Shelly read and checks the Gateway sender on text and binary requests", async () => {
  const send = rs.fn<(message: OutboundEnvelope) => boolean>(() => true);
  const sendFrame = rs.fn(() => true);
  const host = createContainerNodeResponder("NAS", callerId, send, sendFrame);
  const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      id: 0,
      output: false,
      source: "ignored",
    }),
  );
  const action = "shelly.switch.status";
  const payload = { type: "request", action, args: { address: "192.168.10.4" }, from: callerId };
  const sibling = randomUUID();
  await host.receive({ id: randomUUID(), from: sibling, payload });
  expect(send.mock.lastCall?.[0].payload).toMatchObject({ error: { code: "permission_denied" } });
  await host.receiveFrame({
    type: FRAME_TYPE.request,
    id: randomUUID(),
    peer: sibling,
    meta: encodeMeta(payload),
    body: new Uint8Array(),
  });
  expect(sendFrame).toHaveBeenCalledTimes(1);
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "8.8.8.8",
    "10.0.0.1:123",
    "0x0a000102",
    "host.local",
  ]) {
    await host.receive({
      id: randomUUID(),
      from: callerId,
      payload: { ...payload, args: { address } },
    });
    expect(send.mock.lastCall?.[0].payload).toMatchObject({
      error: { code: "invalid_switch_address" },
    });
  }
  for (const forbidden of ["exec", "fs.list", "transfer.open", "shelly.switch.set"]) {
    await host.receive({
      id: randomUUID(),
      from: callerId,
      payload: { ...payload, action: forbidden },
    });
    expect(send.mock.lastCall?.[0].payload).toMatchObject({
      error: { code: "unsupported_action" },
    });
  }
  expect(fetch).not.toHaveBeenCalled();
  await host.receive({ id: randomUUID(), from: callerId, payload });
  expect(fetch).toHaveBeenCalledWith(
    "http://192.168.10.4/rpc/Switch.GetStatus?id=0",
    expect.objectContaining({ redirect: "error" }),
  );
  expect(send.mock.lastCall?.[0].payload).toEqual({
    type: "response",
    ok: true,
    result: { on: false },
  });
  fetch.mockResolvedValueOnce(new Response("x".repeat(9000)));
  await host.receive({ id: randomUUID(), from: callerId, payload });
  expect(send.mock.lastCall?.[0].payload).toMatchObject({ error: { code: "switch_unreachable" } });
});

it("recovers a lost exchange in the same volume, reconnects, and uses a fresh grant after revocation", async () => {
  const volumes = await Promise.all(
    Array.from({ length: 3 }, () => mkdtemp(join(tmpdir(), "container-node-"))),
  );
  const attempts: Array<{ grant?: string; verifier: string; id: string }> = [];
  const revoked = new Set<string>();
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/devices/container-nodes/redeem") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const grant = req.headers.authorization;
      attempts.push({ grant, verifier: input.verifier, id: input.installation_id });
      const approved =
        grant === `Bearer ${first.grant}`
          ? first
          : grant === `Bearer ${second.grant}`
            ? second
            : null;
      if (!approved) {
        res.writeHead(410).end("{}");
        return;
      }
      const original = attempts.find((attempt) => attempt.grant === grant);
      if (original?.verifier !== input.verifier || revoked.has(approved.token)) {
        res.writeHead(409).end("{}");
        return;
      }
      if (attempts.length === 1) {
        req.socket.destroy();
        return;
      }
      res.end(
        JSON.stringify({
          installation_id: input.installation_id,
          token_type: "Bearer",
          access_token: approved.token,
          device_id: approved.id,
          caller_id: callerId,
        }),
      );
    } else if (req.url === "/v1/gateway/config") {
      const token = req.headers.authorization?.slice(7) ?? "";
      if (revoked.has(token)) res.writeHead(401).end('{"error":"invalid_device_session"}');
      else res.end(JSON.stringify({ gatewayPath: CONTAINER_NODE_SOCKET_PATH }));
    } else {
      res.end('{"items":[]}');
    }
  });
  const gateway = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("No loopback address");
  const port = bound.port;
  function start(grant: string, stateDir = volumes[0], hostname = "127.0.0.1") {
    const stop = new AbortController();
    let reachedOnline: () => void;
    const online = new Promise<void>((resolve) => {
      reachedOnline = resolve;
    });
    const running = runContainerNode({
      cloudUrl: `http://${hostname}:${port}`,
      installationId,
      installToken: grant,
      stateDir,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(6000)]),
      onEvent(event) {
        if (event.type === "connection" && event.status === "online") reachedOnline();
      },
    });
    return {
      online: Promise.race([
        online,
        running.then(() => {
          throw new Error("Node stopped before connecting");
        }),
      ]),
      running,
      stop,
    };
  }
  const path = join(volumes[0], "state.json");
  const savedId = async () => JSON.parse(await readFile(path, "utf8")).host.deviceId;
  try {
    const connected = start(first.grant);
    await connected.online;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toMatchObject({
      id: installationId,
      verifier: expect.stringMatching(/^[\w-]{43}$/),
    });
    expect(await savedId()).toBe(first.id);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(volumes[0])).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).not.toContain(first.grant);

    const reconnected = new Promise<void>((resolve) => gateway.once("connection", () => resolve()));
    for (const peer of gateway.clients) peer.close(1011);
    await reconnected;
    expect(attempts).toHaveLength(2);
    connected.stop.abort();
    await expect(connected.running).resolves.toBe("stopped");

    const differentOrigin = start(first.grant, volumes[0], "localhost");
    void differentOrigin.online.catch(() => {});
    await expect(differentOrigin.running).resolves.toBe("needs_pairing");
    expect(attempts).toHaveLength(2);
    expect(await savedId()).toBe(first.id);

    const duplicate = start(first.grant, volumes[1]);
    void duplicate.online.catch(() => {});
    await expect(duplicate.running).resolves.toBe("needs_pairing");
    expect(attempts.at(-1)?.verifier).not.toBe(attempts[0].verifier);
    const expired = start(`romeinstall_${"X".repeat(43)}`, volumes[2]);
    void expired.online.catch(() => {});
    await expect(expired.running).resolves.toBe("needs_pairing");

    const restarted = start(first.grant);
    await restarted.online;
    expect(attempts).toHaveLength(4);
    expect(await savedId()).toBe(first.id);
    revoked.add(first.token);
    for (const peer of gateway.clients) peer.close(4001);
    await expect(restarted.running).resolves.toBe("needs_pairing");
    expect(attempts).toHaveLength(4);
    expect(await readFile(path, "utf8")).not.toContain(first.token);

    const repaired = start(second.grant, volumes[0], "localhost");
    await repaired.online;
    expect(attempts).toHaveLength(5);
    expect(await savedId()).toBe(second.id);
    repaired.stop.abort();
    await expect(repaired.running).resolves.toBe("stopped");
  } finally {
    for (const peer of gateway.clients) peer.terminate();
    gateway.close();
    server.close();
    await Promise.all(volumes.map((volume) => rm(volume, { recursive: true, force: true })));
  }
}, 15_000);

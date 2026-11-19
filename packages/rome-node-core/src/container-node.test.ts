import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it, rs } from "@rstest/core";
import { WebSocketServer } from "ws";
import { CONTAINER_NODE_SOCKET_PATH } from "./container-node-address.js";
import { createContainerNodeResponder } from "./container-node-responder.js";
import { runContainerNode } from "./container-node.js";
import { encodeMeta, FRAME_TYPE } from "./frame.js";
import type { OutboundEnvelope } from "./protocol.js";

const callerId = "96467432-4ead-4cd2-bf84-2504bed44729";
const deviceToken = `romedev_${"B".repeat(43)}`;

afterEach(() => {
  rs.restoreAllMocks();
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

it.each([
  { callerId, socketPath: CONTAINER_NODE_SOCKET_PATH },
  { callerId: undefined, socketPath: "/gateway" },
])("starts with the configured token and reconnects on $socketPath", async ({
  callerId,
  socketPath,
}) => {
  let revoked = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${deviceToken}` || revoked) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_device_session" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ gatewayPath: socketPath }));
  });
  const gateway = new WebSocketServer({ server, path: socketPath });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("No loopback address");
  const stop = new AbortController();
  try {
    const connected = once(gateway, "connection");
    const running = runContainerNode({
      origin: `http://127.0.0.1:${bound.port}`,
      deviceToken,
      callerId,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(7000)]),
    });
    const [socket, request] = await connected;
    expect(request.headers.authorization).toBe(`Bearer ${deviceToken}`);
    const result = once(socket, "message");
    const id = randomUUID();
    const peer = callerId ?? randomUUID();
    socket.send(
      JSON.stringify({ id, from: peer, payload: { type: "request", action: "system.info" } }),
    );
    expect(JSON.parse(String((await result)[0]))).toMatchObject({
      id,
      to: peer,
      payload: { ok: true, result: { platform: "linux" } },
    });
    const reconnected = once(gateway, "connection");
    socket.close(1011);
    const [replacement] = await reconnected;
    revoked = true;
    replacement.close(1011);
    await expect(running).resolves.toBe("revoked");
    expect(requests).toEqual(Array(3).fill("GET /v1/gateway/config"));
  } finally {
    stop.abort();
    for (const socket of gateway.clients) socket.terminate();
    gateway.close();
    server.close();
  }
});

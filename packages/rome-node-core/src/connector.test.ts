import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { DeviceConnector } from "./connector.js";
import type { GatewayClientOptions } from "./client.js";
import type { OutboundEnvelope } from "./protocol.js";
import {
  decodeMeta,
  encodeMeta,
  FRAME_HEADER_BYTES,
  FRAME_TYPE,
  MAX_FRAME_BYTES,
  type Frame,
} from "./frame.js";

const device = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const other = "16fd2706-8baf-433b-82eb-8c7fada847da";

const connectors: DeviceConnector[] = [];
afterEach(() => {
  for (const connector of connectors.splice(0)) connector.stop();
  rs.restoreAllMocks();
});

function fixture(waitMs = 1000) {
  const fetch = rs
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      Response.json(
        String(input).endsWith("config")
          ? { gatewayUrl: "wss://gateway.example/connect" }
          : { items: [{ id: "target" }] },
      ),
    );
  let options!: GatewayClientOptions;
  const sent: OutboundEnvelope[] = [];
  const frames: Frame[] = [];
  const connect = rs.fn((value: GatewayClientOptions) => {
    options = value;
    queueMicrotask(() => value.onStatus?.("online"));
    return {
      send: (message: OutboundEnvelope) => {
        sent.push(message);
        return true;
      },
      sendFrame: (frame: Frame) => {
        frames.push(frame);
        return true;
      },
      stop: () => value.onStatus?.("stopped"),
    };
  });
  const connector = new DeviceConnector({
    credential: { cloudUrl: "https://cloud.example", token: `romedev_${"a".repeat(43)}` },
    connect,
    waitMs,
  });
  connectors.push(connector);
  return { connector, connect, fetch, sent, frames, options: () => options };
}

describe("CLI device connector", () => {
  it("lists devices without opening a Gateway connection or exchanging credentials", async () => {
    const f = fixture();
    expect(await f.connector.list()).toEqual({ items: [{ id: "target" }] });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(String(f.fetch.mock.calls[0][0])).toContain("/api/account/devices");
  });

  it("shares one connection across concurrent requests and matches sender and request ID", async () => {
    const f = fixture();
    const promises = Array.from({ length: 10 }, (_, n) => f.connector.run("target", "exec", { n }));
    await rs.waitFor(() => expect(f.sent).toHaveLength(10));
    expect(f.connect).toHaveBeenCalledTimes(1);
    const done = rs.fn();
    void promises[0].then(done);
    const payload = { type: "response", ok: true, result: { name: "correct" } };
    f.options().onMessage({ id: f.sent[0].id, from: "impostor", payload });
    f.options().onMessage({ id: "wrong-id", from: "target", payload });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    for (const message of f.sent)
      f.options().onMessage({ id: message.id, from: "target", payload });
    expect(await Promise.all(promises)).toEqual(Array.from({ length: 10 }, () => payload));
  });

  it("submits large requests without an application size limit", async () => {
    const f = fixture();
    const args = "x".repeat(33 * 1024 * 1024);
    const pending = f.connector.run("target", "exec", args);
    await rs.waitFor(() => expect(f.sent).toHaveLength(1));
    expect((f.sent[0].payload as { args: string }).args.length).toBe(args.length);
    const payload = { type: "response", ok: true, result: {} };
    f.options().onMessage({ id: f.sent[0].id, from: "target", payload });
    expect(await pending).toEqual(payload);
  });

  it("reports interrupted outcomes without replay and stops after supersession", async () => {
    const f = fixture();
    const pending = f.connector.run("target", "exec", {});
    await rs.waitFor(() => expect(f.sent).toHaveLength(1));
    f.options().onStatus?.("retrying");
    expect(await pending).toMatchObject({ ok: false, error: { code: "unknown_outcome" } });
    f.options().onStatus?.("online");
    expect(f.sent).toHaveLength(1);
    const missing = f.connector.run("missing", "system.info", {});
    await rs.waitFor(() => expect(f.sent).toHaveLength(2));
    f.options().onMessage({ id: f.sent[1].id, type: "error", code: "target_unavailable" });
    expect(await missing).toMatchObject({ error: { code: "target_unavailable" } });
    f.options().onStatus?.("superseded");
    expect(await f.connector.run("target", "exec", {})).toMatchObject({
      error: { code: "gateway_unavailable" },
    });
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it("does not cancel or resend after a wait timeout, and drains pending work on stop", async () => {
    const f = fixture(20);
    expect(await f.connector.run("target", "exec", {})).toMatchObject({
      error: { code: "unknown_outcome" },
    });
    const pending = f.connector.run("target", "exec", {});
    await rs.waitFor(() => expect(f.sent).toHaveLength(2));
    f.connector.stop();
    expect(await pending).toMatchObject({ error: { code: "unknown_outcome" } });
    expect(f.sent).toHaveLength(2);
  });

  it("sends binary requests as frames and matches replies by request ID and sender", async () => {
    const f = fixture();
    const input = Uint8Array.from([0, 255, 10]);
    const pending = f.connector.runBinary(device.toUpperCase(), "exec", { command: "cat" }, input);
    await rs.waitFor(() => expect(f.frames).toHaveLength(1));
    const request = f.frames[0];
    expect(request).toMatchObject({ type: FRAME_TYPE.request, peer: device });
    expect(decodeMeta(request.meta)).toEqual({
      type: "request",
      action: "exec",
      args: { command: "cat" },
    });
    expect(request.body).toBe(input);
    expect(f.sent).toEqual([]);
    const done = rs.fn();
    void pending.then(done);
    const response = { type: "response", ok: true, result: { exitCode: 0 } };
    const reply = (frame: Partial<Frame>) =>
      f.options().onFrame?.({
        type: FRAME_TYPE.response,
        id: request.id,
        peer: device,
        meta: encodeMeta(response),
        body: Uint8Array.from([1, 2]),
        ...frame,
      });
    reply({ peer: other });
    reply({ id: other });
    reply({ type: FRAME_TYPE.request });
    reply({ meta: encodeMeta({ type: "nonsense" }) });
    f.options().onMessage({ id: request.id, from: device, payload: response });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    reply({ body: Uint8Array.from([0, 255]) });
    const result = await pending;
    expect(result.response).toEqual(response);
    expect(Array.from(result.body)).toEqual([0, 255]);
  });

  it("maps binary route errors, rejects non-UUID targets, and reports unknown outcomes", async () => {
    const f = fixture(300);
    expect(await f.connector.runBinary("target", "exec", {}, new Uint8Array())).toMatchObject({
      response: { ok: false, error: { code: "invalid_request" } },
    });
    expect(f.connect).not.toHaveBeenCalled();
    const missing = f.connector.runBinary(device, "exec", {}, new Uint8Array());
    await rs.waitFor(() => expect(f.frames).toHaveLength(1));
    f.options().onFrame?.({
      type: FRAME_TYPE.routeError,
      id: f.frames[0].id,
      peer: device,
      meta: encodeMeta({ code: "target_unavailable" }),
      body: new Uint8Array(),
    });
    const routed = await missing;
    expect(routed.response).toMatchObject({ ok: false, error: { code: "target_unavailable" } });
    expect(routed.body.byteLength).toBe(0);
    expect(
      (await f.connector.runBinary(device, "exec", {}, new Uint8Array())).response,
    ).toMatchObject({ ok: false, error: { code: "unknown_outcome" } });
    const lost = f.connector.runBinary(device, "exec", {}, new Uint8Array());
    await rs.waitFor(() => expect(f.frames).toHaveLength(3));
    f.options().onStatus?.("retrying");
    expect((await lost).response).toMatchObject({ error: { code: "unknown_outcome" } });
    expect(f.frames).toHaveLength(3);
  });

  it("refuses binary input that cannot fit in one frame without disturbing other requests", async () => {
    const f = fixture(5000);
    const pending = f.connector.run("target", "exec", {});
    await rs.waitFor(() => expect(f.sent).toHaveLength(1));
    const meta = encodeMeta({ type: "request", action: "exec", args: {} });
    const fits = MAX_FRAME_BYTES - FRAME_HEADER_BYTES - meta.byteLength;
    const refused = await f.connector.runBinary(device, "exec", {}, new Uint8Array(fits + 1));
    expect(refused.response).toMatchObject({ ok: false, error: { code: "message_too_large" } });
    expect(f.frames).toEqual([]);
    const accepted = f.connector.runBinary(device, "exec", {}, new Uint8Array(fits));
    await rs.waitFor(() => expect(f.frames).toHaveLength(1));
    const payload = { type: "response", ok: true, result: {} };
    f.options().onMessage({ id: f.sent[0].id, from: "target", payload });
    expect(await pending).toEqual(payload);
    f.options().onFrame?.({
      type: FRAME_TYPE.response,
      id: f.frames[0].id,
      peer: device,
      meta: encodeMeta(payload),
      body: new Uint8Array(),
    });
    expect((await accepted).response).toEqual(payload);
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it("submits exactly 128 of a 200-request burst and answers the rest busy", async () => {
    const f = fixture(5000);
    let busy = 0;
    let channels = 0;
    const count = (response: { ok: boolean; error?: { code: string } }) => {
      if (!response.ok && response.error?.code === "busy") busy++;
    };
    const events = { frame() {}, lost() {} };
    for (let n = 0; n < 200; n++) {
      if (n % 3 === 0) void f.connector.run("target", "exec", { n }).then(count);
      else if (n % 3 === 1)
        void f.connector
          .runBinary(device, "exec", { n }, new Uint8Array())
          .then((r) => count(r.response));
      else
        void f.connector.openChannel(device, events).then((result) => {
          if ("send" in result) channels++;
          else count(result);
        });
    }
    await rs.waitFor(() => expect(busy).toBe(72));
    expect(f.sent.length + f.frames.length + channels).toBe(128);
  });
});

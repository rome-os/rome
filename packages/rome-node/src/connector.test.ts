import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { DeviceConnector } from "./connector.js";
import type { GatewayClientOptions } from "./client.js";
import type { OutboundEnvelope } from "./protocol.js";

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
  const connect = rs.fn((value: GatewayClientOptions) => {
    options = value;
    queueMicrotask(() => value.onStatus?.("online"));
    return {
      send: (message: OutboundEnvelope) => {
        sent.push(message);
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
  return { connector, connect, fetch, sent, options: () => options };
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
});

import { afterEach, describe, expect, it, rs as vi } from "@rstest/core";
import { connectGateway, type ClientSocket } from "./client.js";
import { CLOSE } from "./protocol.js";

class Socket implements ClientSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  listeners = new Map<string, ((event: never) => void)[]>();
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", { code });
  }
}
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const messages = vi.fn();
  const statuses = vi.fn();
  const factory = vi.fn((_url: string, _authorization: string) => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const client = connectGateway({
    gatewayUrl: "wss://gateway.test/connect",
    deviceToken: `romedev_${"a".repeat(43)}`,
    createSocket: factory,
    onMessage: messages,
    onStatus: statuses,
    random: () => 0.5,
  });
  return { client, sockets, factory, messages, statuses };
}
describe("device connection helper", () => {
  it("uses a header credential, rejects offline sends, and never queues or resends after disconnect", async () => {
    const f = fixture();
    expect(f.factory).toHaveBeenCalledWith(
      "wss://gateway.test/connect",
      `Bearer romedev_${"a".repeat(43)}`,
    );
    const envelope = { id: "one", to: "target", payload: "hello" };
    expect(f.client.send(envelope)).toBe(false);
    f.sockets[0].open();
    expect(f.client.send({ ...envelope, payload: undefined })).toBe(false);
    expect(f.client.send({ ...envelope, payload: () => null })).toBe(false);
    expect(f.client.send(envelope)).toBe(true);
    f.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    f.sockets[1].open();
    expect(f.sockets[1].sent).toEqual([]);
    f.sockets[0].emit("message", {
      data: JSON.stringify({ id: "old", from: "source", payload: "no" }),
    });
    expect(f.messages).not.toHaveBeenCalled();
    f.sockets[1].emit("message", {
      data: JSON.stringify({ id: "new", from: "source", payload: "yes" }),
    });
    expect(f.messages).toHaveBeenCalledOnce();
    f.client.stop();
  });
  it.each([
    CLOSE.revoked,
    CLOSE.superseded,
  ])("stops reconnecting on terminal close %s", async (code) => {
    const f = fixture();
    f.sockets[0].open();
    f.sockets[0].close(code);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.client.send({ id: "no", to: "target", payload: null })).toBe(false);
    f.client.stop();
  });
  it("backs off immediate failures, times out stuck handshakes, and cancels retries on stop", async () => {
    const f = fixture();
    f.sockets[0].open();
    f.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.factory).toHaveBeenCalledTimes(2);
    f.sockets[1].open();
    f.sockets[1].close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.factory).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sockets[2].readyState).toBe(3);
    f.client.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(3);
  });
  it("leaves message sizes and pending send buffers to the socket adapter", () => {
    const f = fixture();
    f.sockets[0].open();
    f.sockets[0].bufferedAmount = 128 * 1024 * 1024;
    const payload = "x".repeat(33 * 1024 * 1024);
    expect(f.client.send({ id: "large", to: "target", payload })).toBe(true);
    expect(f.sockets[0].sent[0].length).toBeGreaterThan(payload.length);
    f.sockets[0].emit("message", {
      data: JSON.stringify({ id: "large", from: "target", payload }),
    });
    expect(f.messages).toHaveBeenCalledOnce();
    expect(f.messages.mock.calls[0][0].payload.length).toBe(payload.length);
    expect(f.sockets[0].readyState).toBe(1);
    f.client.stop();
  });
  it.each([
    "wss://gateway.test/connect",
    "ws://localhost:8080/connect",
    "ws://127.0.0.1:8080/connect",
    "ws://[::1]:8080/connect",
  ])("connects to an allowed Gateway URL %s", (gatewayUrl) => {
    const factory = vi.fn(() => new Socket());
    const client = connectGateway({
      gatewayUrl,
      deviceToken: `romedev_${"a".repeat(43)}`,
      createSocket: factory,
      onMessage: vi.fn(),
    });
    expect(factory).toHaveBeenCalledWith(gatewayUrl, `Bearer romedev_${"a".repeat(43)}`);
    client.stop();
  });
  it("rejects credentials and plaintext transport outside loopback", () => {
    for (const gatewayUrl of [
      "ws://gateway.test",
      "ws://192.168.1.10",
      "ws://0.0.0.0",
      "ws://[::]",
      "ws://localhost.example",
      "ws://127.0.0.1.example",
      "http://127.0.0.1",
      "ws://user:secret@127.0.0.1",
      "ws://localhost/?token=secret",
      "ws://[::1]/#secret",
      "wss://user:secret@gateway.test",
      "wss://gateway.test/?token=secret",
    ]) {
      expect(() =>
        connectGateway({
          gatewayUrl,
          deviceToken: `romedev_${"a".repeat(43)}`,
          createSocket: vi.fn(),
          onMessage: vi.fn(),
        }),
      ).toThrow();
    }
  });
  it("validates refreshed Gateway URLs before sending credentials on reconnect", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const factory = vi.fn(() => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    });
    const beforeConnect = vi
      .fn()
      .mockResolvedValueOnce("wss://gateway.test/connect")
      .mockResolvedValueOnce("ws://gateway.test/connect")
      .mockResolvedValueOnce("ws://127.0.0.1:8080/connect");
    const client = connectGateway({
      gatewayUrl: "wss://gateway.test/connect",
      deviceToken: `romedev_${"a".repeat(43)}`,
      createSocket: factory,
      onMessage: vi.fn(),
      beforeConnect,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith(
      "ws://127.0.0.1:8080/connect",
      `Bearer romedev_${"a".repeat(43)}`,
    );
    client.stop();
  });
});

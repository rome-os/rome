import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { asWebSocket, FakeWebSocket } from "@/test/fake-websocket";
import { LiveEventsClient, type LiveTopicListener } from "./live-events";

function listener(): LiveTopicListener & {
  onEvent: ReturnType<typeof rs.fn>;
  onReconnect: ReturnType<typeof rs.fn>;
  onDrop: ReturnType<typeof rs.fn>;
  onRejected: ReturnType<typeof rs.fn>;
} {
  return { onEvent: rs.fn(), onReconnect: rs.fn(), onDrop: rs.fn(), onRejected: rs.fn() };
}

function client(): LiveEventsClient {
  return new LiveEventsClient({
    WebSocket: asWebSocket,
    url: () => "ws://rome.test/ws/events",
    idleCloseMs: 1_000,
    openTimeoutMs: 5_000,
    reconnectDelayMs: () => 100,
  });
}

const subscribe = (topic: string) => ({ type: "subscribe", topic });

describe("LiveEventsClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    rs.useFakeTimers();
  });

  afterEach(() => {
    rs.useRealTimers();
  });

  it("opens one socket lazily and sends one subscribe per topic however many listeners share it", () => {
    const live = client();
    expect(FakeWebSocket.instances).toHaveLength(0);

    const first = listener();
    const second = listener();
    live.subscribe("chat.status", first);
    live.subscribe("chat.status", second);
    live.subscribe("apps.catalog", listener());
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.latest();
    expect(socket.url).toBe("ws://rome.test/ws/events");

    socket.open();
    expect(socket.sent).toEqual([subscribe("chat.status"), subscribe("apps.catalog")]);

    socket.receive({ type: "subscribed", topic: "chat.status" });
    live.subscribe("chat.status", listener());
    expect(socket.sent).toHaveLength(2);

    const data = { sessionId: "s1", running: true };
    socket.receive({ type: "event", topic: "chat.status", event: "session_running", data });
    expect(first.onEvent).toHaveBeenCalledWith("session_running", data);
    expect(second.onEvent).toHaveBeenCalledWith("session_running", data);
    expect(first.onReconnect).not.toHaveBeenCalled();
  });

  it("unsubscribes on the last release, and a new topic within the grace delay keeps the socket", () => {
    const live = client();
    const releaseFirst = live.subscribe("chat.session:s1", listener());
    const releaseSecond = live.subscribe("chat.session:s1", listener());
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ type: "subscribed", topic: "chat.session:s1" });

    releaseFirst();
    expect(socket.sent).toEqual([subscribe("chat.session:s1")]);
    releaseSecond();
    expect(socket.sent.at(-1)).toEqual({ type: "unsubscribe", topic: "chat.session:s1" });

    rs.advanceTimersByTime(999);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    live.subscribe("chat.status", listener());
    rs.advanceTimersByTime(1_000);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes the socket once no topic is left after the grace delay", () => {
    const live = client();
    const release = live.subscribe("chat.status", listener());
    const socket = FakeWebSocket.latest();
    socket.open();
    release();
    rs.advanceTimersByTime(1_000);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    rs.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("resubscribes after a drop and resyncs each listener only once the ack arrives", () => {
    const live = client();
    const status = listener();
    const late = listener();
    live.subscribe("chat.status", status);
    const first = FakeWebSocket.latest();
    first.open();
    first.receive({ type: "subscribed", topic: "chat.status" });
    expect(status.onReconnect).not.toHaveBeenCalled();

    first.close();
    expect(status.onDrop).toHaveBeenCalledTimes(1);
    // A listener that joins during the outage has nothing to resync.
    live.subscribe("chat.status", late);
    rs.advanceTimersByTime(100);
    const second = FakeWebSocket.latest();
    expect(second).not.toBe(first);

    second.open();
    expect(second.sent).toEqual([subscribe("chat.status")]);
    expect(status.onReconnect).not.toHaveBeenCalled();
    second.receive({ type: "subscribed", topic: "chat.status" });
    expect(status.onReconnect).toHaveBeenCalledTimes(1);
    expect(late.onReconnect).not.toHaveBeenCalled();

    second.receive({ type: "subscribed", topic: "chat.status" });
    expect(status.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("asks for a rejected topic again only on a later socket, and resyncs once it is accepted", () => {
    const live = client();
    const missing = listener();
    live.subscribe("chat.session:s1", missing);
    live.subscribe("chat.status", listener());
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ type: "error", topic: "chat.session:s1", message: "Subscribe failed" });
    expect(missing.onRejected).toHaveBeenCalledWith("Subscribe failed");
    socket.receive({ type: "subscribed", topic: "chat.status" });
    expect(socket.sent).toEqual([subscribe("chat.session:s1"), subscribe("chat.status")]);

    socket.close();
    rs.advanceTimersByTime(100);
    const next = FakeWebSocket.latest();
    next.open();
    expect(next.sent).toEqual([subscribe("chat.session:s1"), subscribe("chat.status")]);
    expect(missing.onReconnect).not.toHaveBeenCalled();
    next.receive({ type: "subscribed", topic: "chat.session:s1" });
    expect(missing.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("asks for a rejected topic again when a new listener subscribes to it", () => {
    const live = client();
    live.subscribe("chat.session:gone", listener());
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ type: "error", topic: "chat.session:gone", message: "Not found" });

    live.subscribe("chat.session:gone", listener());
    expect(socket.sent).toEqual([subscribe("chat.session:gone"), subscribe("chat.session:gone")]);
  });

  it("grows the backoff while sockets drop right after opening, and restarts it after a stable one", () => {
    const delays: number[] = [];
    const live = new LiveEventsClient({
      WebSocket: asWebSocket,
      url: () => "ws://rome.test/ws/events",
      reconnectDelayMs: (attempt) => {
        delays.push(attempt);
        return 100;
      },
      stableOpenMs: 2_000,
    });
    live.subscribe("chat.status", listener());
    for (let drop = 0; drop < 3; drop++) {
      FakeWebSocket.latest().open();
      FakeWebSocket.latest().close();
      rs.advanceTimersByTime(100);
    }
    expect(delays).toEqual([1, 2, 3]);

    FakeWebSocket.latest().open();
    rs.advanceTimersByTime(2_000);
    FakeWebSocket.latest().close();
    expect(delays).toEqual([1, 2, 3, 1]);
  });

  it("rides out fast failed opens within the window, as while the backend restarts", () => {
    const live = client();
    const status = listener();
    live.subscribe("chat.status", status);
    for (let attempt = 0; attempt < 3; attempt++) {
      FakeWebSocket.latest().close();
      rs.advanceTimersByTime(100);
    }
    expect(live.getTransport()).toBe("socket");

    const socket = FakeWebSocket.latest();
    socket.open();
    expect(socket.sent).toEqual([subscribe("chat.status")]);
  });

  it("falls back to SSE once opens keep failing past the window, resyncing the listeners that waited", () => {
    const live = client();
    const status = listener();
    const transportChanged = rs.fn();
    live.onTransportChange(transportChanged);
    live.subscribe("chat.status", status);
    expect(live.getTransport()).toBe("socket");

    FakeWebSocket.latest().close();
    // A proxy that holds the upgrade open counts as a failed attempt.
    for (let attempt = 0; attempt < 2; attempt++) {
      rs.advanceTimersByTime(100);
      rs.advanceTimersByTime(5_000);
    }
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(live.getTransport()).toBe("socket");
    rs.advanceTimersByTime(100);
    rs.advanceTimersByTime(5_000);

    expect(live.getTransport()).toBe("fallback");
    expect(transportChanged).toHaveBeenCalledTimes(1);
    expect(status.onReconnect).toHaveBeenCalledTimes(1);
    rs.advanceTimersByTime(59_999);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("probes the socket again from the fallback and moves back once one opens", () => {
    const live = client();
    const status = listener();
    const transportChanged = rs.fn();
    live.onTransportChange(transportChanged);
    live.subscribe("chat.status", status);
    for (let attempt = 0; attempt < 4; attempt++) {
      FakeWebSocket.latest().close();
      rs.advanceTimersByTime(5_000);
    }
    expect(live.getTransport()).toBe("fallback");
    expect(status.onReconnect).toHaveBeenCalledTimes(1);
    const sockets = FakeWebSocket.instances.length;

    // A failed probe stays on SSE without reporting a drop, and tries again later.
    rs.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(sockets + 1);
    FakeWebSocket.latest().close();
    expect(live.getTransport()).toBe("fallback");
    expect(status.onDrop).not.toHaveBeenCalled();

    // A listener added on the fallback resyncs too once the socket takes over.
    const session = listener();
    live.subscribe("chat.session:s1", session);
    rs.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(sockets + 2);
    const socket = FakeWebSocket.latest();
    socket.open();
    expect(live.getTransport()).toBe("socket");
    expect(transportChanged).toHaveBeenCalledTimes(2);
    expect(socket.sent).toEqual([subscribe("chat.status"), subscribe("chat.session:s1")]);
    expect(status.onReconnect).toHaveBeenCalledTimes(1);

    socket.receive({ type: "subscribed", topic: "chat.status" });
    socket.receive({ type: "subscribed", topic: "chat.session:s1" });
    expect(status.onReconnect).toHaveBeenCalledTimes(2);
    expect(session.onReconnect).toHaveBeenCalledTimes(1);

    // Once back on the socket, a drop reconnects rather than falling back.
    socket.close();
    expect(status.onDrop).toHaveBeenCalledTimes(1);
    rs.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(sockets + 3);
    expect(live.getTransport()).toBe("socket");
  });

  it("keeps reconnecting rather than falling back once a socket has opened", () => {
    const live = client();
    live.subscribe("chat.status", listener());
    FakeWebSocket.latest().open();
    for (let attempt = 0; attempt < 5; attempt++) {
      FakeWebSocket.latest().close();
      rs.advanceTimersByTime(100);
    }
    expect(live.getTransport()).toBe("socket");
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  it("reports fallback up front when there is no WebSocket", () => {
    const live = new LiveEventsClient();
    expect(live.getTransport()).toBe("fallback");
  });

  it("drops malformed frames and events for topics nobody holds", () => {
    const error = rs.spyOn(console, "error").mockImplementation(() => {});
    const live = client();
    const status = listener();
    live.subscribe("chat.status", status);
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive("not json");
    socket.receive({ type: "event", topic: "apps.catalog", event: "catalog-change", data: {} });
    expect(status.onEvent).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Invalid live events message");
    error.mockRestore();
  });

  describe("hold", () => {
    it("opens the socket with no topic and keeps it open, reconnecting, until released", () => {
      const live = client();
      const release = live.hold();
      expect(FakeWebSocket.instances).toHaveLength(1);
      const socket = FakeWebSocket.latest();
      socket.open();
      rs.advanceTimersByTime(5_000);
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);

      socket.close();
      rs.advanceTimersByTime(100);
      const next = FakeWebSocket.latest();
      expect(next).not.toBe(socket);
      next.open();

      release();
      release();
      rs.advanceTimersByTime(1_000);
      expect(next.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it("keeps the socket after the last topic goes while held", () => {
      const live = client();
      const unsubscribe = live.subscribe("chat.status", listener());
      const release = live.hold();
      const socket = FakeWebSocket.latest();
      socket.open();
      unsubscribe();
      rs.advanceTimersByTime(5_000);
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
      release();
      rs.advanceTimersByTime(1_000);
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    });
  });

  describe("reportActivity", () => {
    const active = { type: "activity", state: "active" };
    const away = { type: "activity", state: "away" };

    function openClient() {
      let now = 0;
      const live = new LiveEventsClient({
        WebSocket: asWebSocket,
        url: () => "ws://rome.test/ws/events",
        reconnectDelayMs: () => 100,
        activityIntervalMs: 30_000,
        now: () => now,
      });
      live.subscribe("chat.status", listener());
      const socket = FakeWebSocket.latest();
      socket.open();
      socket.sent.length = 0;
      return { live, socket, advance: (ms: number) => (now += ms) };
    }

    it("sends active at most once every interval", () => {
      const { live, socket, advance } = openClient();
      live.reportActivity("active");
      advance(29_999);
      live.reportActivity("active");
      expect(socket.sent).toEqual([active]);
      advance(1);
      live.reportActivity("active");
      expect(socket.sent).toEqual([active, active]);
    });

    it("sends away at once after an active, and the next input is active again at once", () => {
      const { live, socket, advance } = openClient();
      live.reportActivity("away");
      expect(socket.sent).toEqual([]);
      live.reportActivity("active");
      advance(1_000);
      live.reportActivity("away");
      live.reportActivity("away");
      live.reportActivity("active");
      expect(socket.sent).toEqual([active, away, active]);
    });

    it("sends nothing while the socket is down, and active at once on a new socket", () => {
      const { live, socket } = openClient();
      live.reportActivity("active");
      socket.close();
      live.reportActivity("active");
      live.reportActivity("away");
      rs.advanceTimersByTime(100);
      const next = FakeWebSocket.latest();
      next.open();
      next.sent.length = 0;
      live.reportActivity("active");
      expect(socket.sent).toEqual([active]);
      expect(next.sent).toEqual([active]);
    });
  });
});

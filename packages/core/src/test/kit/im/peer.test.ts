import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { PeerServer, requestBarrier } from "./peer.js";

describe("PeerServer", () => {
  let server: PeerServer;
  let created = 0;

  beforeEach(async () => {
    created = 0;
    server = await new PeerServer(({ method, path }) => {
      if (method !== "POST" || path !== "/messages") return undefined;
      created += 1;
      return { body: { id: created }, source: "capture", accepted: true };
    }).start();
  });

  afterEach(() => server.close());

  const post = (path = "/messages") =>
    server.fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });

  it("records each exchange with its source and whether it changed the platform", async () => {
    await post();

    expect(server.exchanges).toEqual([
      {
        request: { method: "POST", path: "/messages", body: { text: "hi" } },
        response: { status: 200, body: { id: 1 } },
        source: "capture",
        accepted: true,
      },
    ]);
    server.assertClean();
  });

  it("keeps an exchange's answer as it was sent, whatever the route does later", async () => {
    const live: number[] = [];
    const peer = await new PeerServer(() => ({ body: live, source: "synthetic" })).start();
    try {
      await peer.fetch(`${peer.url}/updates`, { method: "POST" });
      live.push(1);
      expect(peer.exchanges[0]?.response?.body).toEqual([]);
    } finally {
      await peer.close();
    }
  });

  it("fails the test on a request no route models", async () => {
    expect((await post("/unknown")).status).toBe(418);
    expect(() => server.assertClean()).toThrow("Unmodeled request: POST /unknown");
  });

  it("answers a scripted response without running the route", async () => {
    server.once({
      method: "POST",
      path: "/messages",
      respond: { status: 429, body: { retry: 1 } },
    });

    const response = await post();

    expect([response.status, await response.json(), created]).toEqual([429, { retry: 1 }, 0]);
    expect(server.exchanges[0]).toMatchObject({ source: "fault", accepted: false });
  });

  it("applies a request and then drops the answer", async () => {
    server.once({ method: "POST", path: "/messages", dropAfterAccept: true });

    await expect(post()).rejects.toThrow();

    expect(created).toBe(1);
    expect(server.exchanges[0]).toMatchObject({ accepted: true, dropped: true });
    expect(server.exchanges[0]?.response).toBeUndefined();
  });

  it("holds a request until the test releases it", async () => {
    const barrier = requestBarrier();
    server.once({ method: "POST", path: "/messages", before: barrier.wait });

    const pending = post();
    await barrier.entered;
    expect(created).toBe(0);
    barrier.release();

    expect((await pending).status).toBe(200);
    expect(created).toBe(1);
  });

  it("refuses a request to any other origin", async () => {
    await expect(server.fetch("https://example.com/messages")).rejects.toThrow(
      "Peer blocked a request to https://example.com",
    );
  });

  it("reports a scripted fault that never fired", () => {
    server.once({ method: "POST", path: "/messages", dropAfterAccept: true });

    expect(() => server.assertClean()).toThrow("1 scripted faults never fired");
  });
});

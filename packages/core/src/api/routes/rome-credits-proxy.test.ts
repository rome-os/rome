import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { ROME_CREDITS_PROXY_SECRET } from "../../core/rome-credits-proxy.js";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";
import { romeCreditsProxyRoutes } from "./rome-credits-proxy.js";

const CLOUD = "https://cloud.example";
const INSTANCE_TOKEN = "romeinst_proxy_test";
const URL_BASE = "http://127.0.0.1:4141/_internal/rome-credits";
const authorized = { authorization: `Bearer ${ROME_CREDITS_PROXY_SECRET}` };

beforeEach(() => {
  rs.stubEnv("PANTHEON_BASE_ORIGIN", CLOUD);
  rs.stubEnv("ROME_SIGNER_SOCKET", "");
  setInstanceTokenInMemory(INSTANCE_TOKEN);
});
afterEach(() => {
  rs.unstubAllEnvs();
  setInstanceTokenInMemory(null);
});

function proxy(upstream: (request: Request) => Response | Promise<Response>) {
  const forwarded: Request[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    const request = new Request(input, init);
    forwarded.push(request);
    return upstream(request);
  }) as unknown as typeof fetch;
  return { app: romeCreditsProxyRoutes("127.0.0.1", fetchImpl), forwarded };
}

describe("Rome credits proxy", () => {
  it("refuses to register on a listener that is not loopback", () => {
    expect(() => romeCreditsProxyRoutes("0.0.0.0")).toThrow("loopback");
  });

  it.each([
    ["no credential", {}],
    ["the Rome Cloud instance token", { authorization: `Bearer ${INSTANCE_TOKEN}` }],
    ["another key", { authorization: "Bearer not-the-key" }],
  ])("rejects a request with %s", async (_name, headers) => {
    const { app, forwarded } = proxy(() => new Response("{}"));
    const response = await app.request(`${URL_BASE}/v1/responses`, { method: "POST", headers });
    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("forwards method, query, body and headers with the Rome Cloud bearer instead of the proxy key", async () => {
    const { app, forwarded } = proxy(() => Response.json({ id: "resp_1" }, { status: 201 }));
    const response = await app.request(`${URL_BASE}/v1/responses?stream=true`, {
      method: "POST",
      headers: {
        ...authorized,
        "content-type": "application/json",
        cookie: "session=secret",
        "x-codex-turn": "7",
      },
      body: JSON.stringify({ model: "gpt" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "resp_1" });
    expect(forwarded).toHaveLength(1);
    const request = forwarded[0];
    expect(request.url).toBe(`${CLOUD}/v1/responses?stream=true`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${INSTANCE_TOKEN}`);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-codex-turn")).toBe("7");
    expect(request.headers.get("cookie")).toBeNull();
    expect(await request.json()).toEqual({ model: "gpt" });
  });

  it("streams the response as it arrives", async () => {
    let finish!: () => void;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        finish = () => {
          controller.enqueue(encoder.encode("data: two\n\n"));
          controller.close();
        };
      },
    });
    const { app } = proxy(
      () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const response = await app.request(`${URL_BASE}/v1/responses`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    finish();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("data: two\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("passes an upstream error status through", async () => {
    const { app } = proxy(() => new Response('{"error":"insufficient_credits"}', { status: 402 }));
    const response = await app.request(`${URL_BASE}/v1/responses`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "insufficient_credits" });
  });

  it("answers 503 and sends nothing when the instance is not linked", async () => {
    setInstanceTokenInMemory(null);
    const { app, forwarded } = proxy(() => new Response("{}"));
    const response = await app.request(`${URL_BASE}/v1/responses`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it("only forwards the inference gateway", async () => {
    const { app, forwarded } = proxy(() => new Response("{}"));
    const response = await app.request(`${URL_BASE}/v2/responses`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });
});

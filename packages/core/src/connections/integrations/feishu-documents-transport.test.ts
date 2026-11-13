import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { CredentialRejected } from "../errors.js";
import { createFeishuDocumentActor, FEISHU_DOCUMENT_READ } from "./feishu-documents.js";

const call = { operation: FEISHU_DOCUMENT_READ, input: { documentId: "DocumentA" } };
const material = {
  appId: "cli_cold_fixture",
  appSecret: "synthetic-only",
  domain: "feishu" as const,
};

afterEach(() => {
  rs.restoreAllMocks();
});

async function fixture(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const original = defaultHttpInstance.create.bind(defaultHttpInstance);
  const requests: Array<{
    path: string;
    timeout: number | undefined;
    bounded: boolean;
    cancellable: boolean;
  }> = [];
  const redirect: Parameters<typeof defaultHttpInstance.interceptors.request.use>[0] = (input) => {
    const path = new URL(input.url!).pathname;
    requests.push({
      path,
      timeout: input.timeout,
      bounded: input.maxContentLength === 256 * 1024,
      cancellable: !!input.signal,
    });
    input.url = `http://127.0.0.1:${address.port}${path}`;
    input.proxy = false;
    return input;
  };
  const direct = defaultHttpInstance.interceptors.request.use(redirect);
  rs.spyOn(defaultHttpInstance, "create").mockImplementation((config) => {
    const http = original(config);
    http.interceptors.request.use(redirect);
    return http;
  });
  return {
    requests,
    async close() {
      defaultHttpInstance.interceptors.request.eject(direct);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("Feishu document reads with the real SDK and loopback HTTP", () => {
  for (const code of [10003, 10014]) {
    for (const status of [200, 400]) {
      it(`classifies token credential code ${code} with HTTP ${status} without exposing provider text`, async () => {
        const h = await fixture((_request, response) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ code, msg: "SYNTHETIC_PRIVATE_PROVIDER_ERROR" }));
        });
        const actor = createFeishuDocumentActor({
          ...material,
          appId: `cli_rejected_${code}_${status}`,
        });
        try {
          await expect(actor.invoke(call)).rejects.toEqual(
            new CredentialRejected({ grant: "app" }),
          );
          expect(h.requests).toHaveLength(1);
        } finally {
          actor.stop?.();
          await h.close();
        }
      });
    }
  }

  it("bounds both a cold token POST and the document GET and isolates cache across actor epochs", async () => {
    let tokens = 0;
    const h = await fixture((request, response) => {
      if (request.url?.includes("tenant_access_token")) {
        tokens++;
        json(response, { code: 0, expire: 7200, tenant_access_token: "t-synthetic-fixture" });
      } else json(response, { code: 0, data: { content: "synthetic document" } });
    });
    const first = createFeishuDocumentActor(material);
    const replacement = createFeishuDocumentActor({
      ...material,
      appSecret: "synthetic-replacement",
    });
    try {
      await first.invoke(call);
      await first.invoke(call);
      await replacement.invoke(call);
      expect(tokens).toBe(2);
      expect(h.requests).toHaveLength(5);
      for (const request of h.requests) {
        expect(request).toMatchObject({ timeout: 15000, bounded: true, cancellable: true });
        expect(request.path).toMatch(
          /^\/open-apis\/(auth\/v3\/tenant_access_token\/internal|docx\/v1\/documents\/DocumentA\/raw_content)$/,
        );
      }
    } finally {
      first.stop?.();
      replacement.stop?.();
      await h.close();
    }
  });

  it("stop physically closes a cold-token socket instead of only rejecting the read", async () => {
    let started!: () => void;
    let closed!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const h = await fixture((_request, response) => {
      response.on("close", closed);
      started();
    });
    const actor = createFeishuDocumentActor({ ...material, appId: "cli_stop_fixture" });
    try {
      const pending = actor.invoke(call);
      const rejected = expect(pending).rejects.toThrow();
      await ready;
      actor.stop?.();
      await rejected;
      await Promise.race([
        disconnected,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Token socket remained open")), 2000),
        ),
      ]);
      expect(h.requests).toHaveLength(1);
    } finally {
      actor.stop?.();
      await h.close();
    }
  });

  it("the operation deadline also closes a cold-token socket", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    rs.spyOn(AbortSignal, "timeout").mockImplementationOnce((milliseconds) => {
      expect(milliseconds).toBe(15000);
      return timeout(1500);
    });
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const h = await fixture((_request, response) => {
      response.on("close", closed);
    });
    const actor = createFeishuDocumentActor({ ...material, appId: "cli_deadline_fixture" });
    try {
      await expect(actor.invoke(call)).rejects.toThrow();
      await Promise.race([
        disconnected,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Deadline left the token socket open")), 2000),
        ),
      ]);
      expect(h.requests).toHaveLength(1);
    } finally {
      actor.stop?.();
      await h.close();
    }
  });

  it("maps the real Axios response ceiling to a permanent failure", async () => {
    const h = await fixture((request, response) => {
      if (request.url?.includes("tenant_access_token"))
        json(response, { code: 0, expire: 7200, tenant_access_token: "t-synthetic-fixture" });
      else json(response, { code: 0, data: { content: "x".repeat(300 * 1024) } });
    });
    const actor = createFeishuDocumentActor({ ...material, appId: "cli_size_fixture" });
    try {
      await expect(actor.invoke(call)).rejects.toMatchObject({
        reason: "provider_response_too_large",
        retryable: false,
      });
    } finally {
      actor.stop?.();
      await h.close();
    }
  });
});

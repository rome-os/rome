import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import { vaultRoutes } from "./vault.js";

const guardian: SessionActor = { kind: "guardian", userId: "owner", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "guest", email: "guest@example.com" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

interface SignerCall {
  method: string;
  url: string;
  body: string;
}

// A signer double on a unix socket that records each request and answers from a map.
async function startSignerDouble(answers: Record<string, { status: number; body: unknown }>) {
  const directory = await mkdtemp(join(tmpdir(), "vault-route-"));
  const socketPath = join(directory, "signer.sock");
  const calls: SignerCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString(),
      });
      const answer = answers[`${req.method} ${req.url}`] ?? { status: 404, body: { error: "x" } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    calls,
    async close() {
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function appFor(actor: SessionActor | null): Hono {
  const app = new Hono();
  app.use("*", (_c, next) => (actor ? runWithSessionActor(actor, next) : next()));
  app.route("/", vaultRoutes());
  return app;
}

describe("vaultRoutes", () => {
  let signer: Awaited<ReturnType<typeof startSignerDouble>>;
  const LIST = {
    secrets: [
      {
        name: "GITHUB_TOKEN",
        description: "CI",
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        lastUsedAt: null,
      },
    ],
  };

  beforeEach(async () => {
    signer = await startSignerDouble({
      "GET /v1/secrets": { status: 200, body: LIST },
      "PUT /v1/secrets/GITHUB_TOKEN": { status: 200, body: { ok: true } },
      "DELETE /v1/secrets/GITHUB_TOKEN": { status: 200, body: { ok: true } },
    });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
  });

  afterEach(async () => {
    rs.unstubAllEnvs();
    await signer.close();
  });

  it("lets a guardian list, save and remove, forwarding to the signer", async () => {
    const app = appFor(guardian);
    const list = await app.request("/vault");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(LIST);

    const saved = await app.request("/vault/GITHUB_TOKEN", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ value: "ghp_secret", description: "CI" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });

    const removed = await app.request("/vault/GITHUB_TOKEN", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(removed.status).toBe(200);

    expect(signer.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /v1/secrets",
      "PUT /v1/secrets/GITHUB_TOKEN",
      "DELETE /v1/secrets/GITHUB_TOKEN",
    ]);
    expect(JSON.parse(signer.calls[1].body)).toEqual({ value: "ghp_secret", description: "CI" });
  });

  it("maps an unknown secret on delete to 404", async () => {
    const response = await appFor(guardian).request("/vault/MISSING_ONE", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["a visitor", visitor],
    ["an anonymous caller", { kind: "anonymous" } as SessionActor],
    ["no session", null],
  ])("rejects %s on every route without reaching the signer", async (_label, actor) => {
    const app = appFor(actor);
    expect((await app.request("/vault")).status).toBe(403);
    for (const [method, body] of [
      ["PUT", JSON.stringify({ value: "v" })],
      ["DELETE", undefined],
    ] as const) {
      const response = await app.request("/vault/GITHUB_TOKEN", {
        method,
        headers: SAME_ORIGIN,
        body,
      });
      expect(response.status).toBe(403);
    }
    expect(signer.calls).toEqual([]);
  });

  it("rejects cross-site writes from a guardian session", async () => {
    const app = appFor(guardian);
    const foreign: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site", origin: "https://attacker.example" },
      { origin: "https://sibling.example.com" },
      {},
    ];
    for (const headers of foreign) {
      const response = await app.request("https://rome.example.com/vault/GITHUB_TOKEN", {
        method: "PUT",
        headers,
        body: JSON.stringify({ value: "v" }),
      });
      expect(response.status).toBe(403);
    }
    expect(signer.calls).toEqual([]);
  });

  it("validates names and bodies before forwarding", async () => {
    const app = appFor(guardian);
    const put = (name: string, body: unknown) =>
      app.request(`/vault/${name}`, {
        method: "PUT",
        headers: SAME_ORIGIN,
        body: JSON.stringify(body),
      });
    expect((await put("lower", { value: "v" })).status).toBe(400);
    expect((await put("GITHUB_TOKEN", {})).status).toBe(400);
    expect((await put("GITHUB_TOKEN", { value: "" })).status).toBe(400);
    expect((await put("GITHUB_TOKEN", { value: "x".repeat(32769) })).status).toBe(400);
    expect((await put("GITHUB_TOKEN", { value: "v", description: 5 })).status).toBe(400);
    expect((await put("GITHUB_TOKEN", { value: "v", description: "d".repeat(201) })).status).toBe(
      400,
    );
    expect(signer.calls).toEqual([]);
  });

  it("answers 503 when the instance has no signer", async () => {
    rs.stubEnv("ROME_SIGNER_SOCKET", "");
    const app = appFor(guardian);
    const list = await app.request("/vault");
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({
      error: "The vault needs the signer, which is not running on this instance.",
    });
    const saved = await app.request("/vault/GITHUB_TOKEN", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ value: "v" }),
    });
    expect(saved.status).toBe(503);
  });

  it("answers 503 when the signer socket is not reachable", async () => {
    rs.stubEnv("ROME_SIGNER_SOCKET", join(tmpdir(), "no-such-signer.sock"));
    expect((await appFor(guardian).request("/vault")).status).toBe(503);
  });
});

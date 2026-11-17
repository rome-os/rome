import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import { ApprovalsRepository } from "../../apps/repositories/approvals.js";
import type { ApprovalHandler } from "../../apps/actions/approval-handler.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { vaultRoutes } from "./vault.js";

const guardian: SessionActor = { kind: "guardian", userId: "owner", via: "cookie" };
const loopback: SessionActor = { kind: "guardian", userId: "owner", via: "loopback" };
const PIN = "246810";
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
    answers,
    async close() {
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

let testDb: TestDb;
let approvalHandler: ApprovalHandler;

function appFor(actor: SessionActor | null): Hono {
  const app = new Hono();
  app.use("*", (_c, next) => (actor ? runWithSessionActor(actor, next) : next()));
  app.route(
    "/",
    vaultRoutes({ approvalsRepo: new ApprovalsRepository(testDb.db), approvalHandler }),
  );
  return app;
}

/** A pending approval of `vault_apply`, as the engine stores it. */
function askForSecret(args: Record<string, unknown>, actionName = "system:vault_apply") {
  return new ApprovalsRepository(testDb.db).create({
    type: "action_execution",
    requestedBy: "agent",
    description: "Use GITHUB_TOKEN",
    payload: { actionName, args, preview: { kind: "secret_access" } },
  });
}

const post = (app: Hono, path: string, body: unknown, headers = SAME_ORIGIN) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

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
    pin: { set: true, lockedUntil: null },
  };

  // The routes ask the signer for its health before every other call.
  const forwarded = () => signer.calls.filter((call) => call.url !== "/v1/health");

  beforeEach(async () => {
    testDb = createTestDb();
    approvalHandler = {
      onApproved: rs.fn(async () => {}),
      onRejected: rs.fn(async () => {}),
    } as unknown as ApprovalHandler;
    signer = await startSignerDouble({
      "GET /v1/health": { status: 200, body: { ok: true, vault: 2 } },
      "POST /v1/pin": { status: 200, body: { ok: true } },
      "POST /v1/reset": { status: 200, body: { ok: true } },
      "POST /v1/grants": { status: 200, body: { name: "GITHUB_TOKEN", expiresAt: "x" } },
      "GET /v1/secrets": { status: 200, body: LIST },
      "PUT /v1/secrets/GITHUB_TOKEN": { status: 200, body: { ok: true } },
      "DELETE /v1/secrets/GITHUB_TOKEN": { status: 200, body: { ok: true } },
    });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
  });

  afterEach(async () => {
    rs.unstubAllEnvs();
    testDb.close();
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
      body: JSON.stringify({ value: "ghp_secret", description: "CI", pin: PIN }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });

    const removed = await app.request("/vault/GITHUB_TOKEN", {
      method: "DELETE",
      headers: SAME_ORIGIN,
    });
    expect(removed.status).toBe(200);

    expect(forwarded().map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /v1/secrets",
      "PUT /v1/secrets/GITHUB_TOKEN",
      "DELETE /v1/secrets/GITHUB_TOKEN",
    ]);
    expect(JSON.parse(forwarded()[1].body)).toEqual({
      value: "ghp_secret",
      description: "CI",
      pin: PIN,
    });
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
    expect((await put("GITHUB_TOKEN", { value: "secret\u0000value" })).status).toBe(400);
    expect((await put("GITHUB_TOKEN", { value: "v", description: 5 })).status).toBe(400);
    expect((await put("GITHUB_TOKEN", { value: "v", description: "d".repeat(201) })).status).toBe(
      400,
    );
    expect(forwarded()).toEqual([]);
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

  it("lets a loopback guardian list and delete, but not save, reset or grant", async () => {
    const app = appFor(loopback);
    expect((await app.request("/vault")).status).toBe(200);
    expect(
      (await app.request("/vault/GITHUB_TOKEN", { method: "DELETE", headers: SAME_ORIGIN })).status,
    ).toBe(200);
    const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
    for (const [path, body] of [
      ["/vault/pin", { pin: PIN }],
      ["/vault/reset", { pin: PIN }],
      ["/vault/grants", { approvalId: id, names: ["GITHUB_TOKEN"], ttlMinutes: 15, pin: PIN }],
    ] as const) {
      expect((await post(app, path, body)).status).toBe(403);
    }
    const put = await app.request("/vault/GITHUB_TOKEN", {
      method: "PUT",
      headers: SAME_ORIGIN,
      body: JSON.stringify({ value: "v", pin: PIN }),
    });
    expect(put.status).toBe(403);
    expect(forwarded().map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect((await new ApprovalsRepository(testDb.db).findById(id))?.status).toBe("pending");
  });

  it.each([
    ["an old signer without the vault level", { ok: true }],
    ["a signer on vault level 1", { ok: true, vault: 1 }],
  ])("answers 503 signer_outdated and forwards nothing for %s", async (_label, health) => {
    signer.answers["GET /v1/health"] = { status: 200, body: health };
    const app = appFor(guardian);
    const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
    const responses = [
      await app.request("/vault"),
      await app.request("/vault/GITHUB_TOKEN", { method: "DELETE", headers: SAME_ORIGIN }),
      await app.request("/vault/GITHUB_TOKEN", {
        method: "PUT",
        headers: SAME_ORIGIN,
        body: JSON.stringify({ value: "v", pin: PIN }),
      }),
      await post(app, "/vault/pin", { pin: PIN }),
      await post(app, "/vault/reset", { pin: PIN }),
      await post(app, "/vault/grants", {
        approvalId: id,
        names: ["GITHUB_TOKEN"],
        ttlMinutes: 15,
        pin: PIN,
      }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "The signer is too old for the vault. Upgrade the instance.",
        code: "signer_outdated",
      });
    }
    expect(forwarded()).toEqual([]);
    expect((await new ApprovalsRepository(testDb.db).findById(id))?.status).toBe("pending");
  });

  it("forwards a new PIN and a reset, and relays the signer's refusal with its body", async () => {
    const app = appFor(guardian);
    expect(await (await post(app, "/vault/pin", { pin: PIN })).json()).toEqual({ ok: true });
    expect(await (await post(app, "/vault/reset", { pin: PIN })).json()).toEqual({ ok: true });
    expect(forwarded().map((call) => [call.url, JSON.parse(call.body)])).toEqual([
      ["/v1/pin", { pin: PIN }],
      ["/v1/reset", { pin: PIN }],
    ]);

    const refusals: Array<[string, number, Record<string, unknown>]> = [
      ["PUT /v1/secrets/GITHUB_TOKEN", 403, { error: "wrong_pin", attemptsLeft: 2 }],
      [
        "PUT /v1/secrets/GITHUB_TOKEN",
        423,
        { error: "locked", lockedUntil: "2026-11-16T10:15:00Z" },
      ],
      ["PUT /v1/secrets/GITHUB_TOKEN", 409, { error: "pin_not_set" }],
      ["PUT /v1/secrets/GITHUB_TOKEN", 400, { error: "invalid_pin" }],
      ["POST /v1/pin", 409, { error: "pin_already_set" }],
    ];
    for (const [key, status, body] of refusals) {
      signer.answers[key] = { status, body };
      const response = key.startsWith("PUT")
        ? await app.request("/vault/GITHUB_TOKEN", {
            method: "PUT",
            headers: SAME_ORIGIN,
            body: JSON.stringify({ value: "v", pin: "000000" }),
          })
        : await post(app, "/vault/pin", { pin: PIN });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
  });

  it("answers 503, not 502, when the signer fails in any other way", async () => {
    const app = appFor(guardian);
    signer.answers["GET /v1/secrets"] = { status: 502, body: { error: "x" } };
    signer.answers["PUT /v1/secrets/GITHUB_TOKEN"] = { status: 500, body: { error: "x" } };
    signer.answers["DELETE /v1/secrets/GITHUB_TOKEN"] = { status: 500, body: { error: "x" } };
    signer.answers["POST /v1/reset"] = { status: 500, body: { error: "x" } };
    expect((await app.request("/vault")).status).toBe(503);
    expect(
      (
        await app.request("/vault/GITHUB_TOKEN", {
          method: "PUT",
          headers: SAME_ORIGIN,
          body: JSON.stringify({ value: "v", pin: PIN }),
        })
      ).status,
    ).toBe(503);
    expect(
      (await app.request("/vault/GITHUB_TOKEN", { method: "DELETE", headers: SAME_ORIGIN })).status,
    ).toBe(503);
    expect((await post(app, "/vault/reset", { pin: PIN })).status).toBe(503);
  });

  const grantBody = (approvalId: string, over: Record<string, unknown> = {}) => ({
    approvalId,
    names: ["GITHUB_TOKEN"],
    ttlMinutes: 15,
    pin: PIN,
    ...over,
  });

  describe("POST /vault/grants", () => {
    const status = async (id: string) =>
      (await new ApprovalsRepository(testDb.db).findById(id))?.status;

    it("forwards the PIN and approves the approval through the shared path", async () => {
      const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(forwarded().map((call) => [call.method, call.url, JSON.parse(call.body)])).toEqual([
        ["POST", "/v1/grants", { names: ["GITHUB_TOKEN"], ttlSeconds: 900, pin: PIN }],
      ]);
      expect(await status(id)).toBe("approved");
      expect(approvalHandler.onApproved).toHaveBeenCalledWith(id);
      const row = await new ApprovalsRepository(testDb.db).findById(id);
      expect(row?.resolvedBy).toBe("owner");
    });

    it("grants several secrets with one request, in the order the approval holds", async () => {
      const names = ["GITHUB_TOKEN", "STRIPE_KEY", "AWS_KEY"];
      const id = await askForSecret({ names, reason: "r" });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id, { names }));
      expect(response.status).toBe(200);
      expect(forwarded().map((call) => [call.url, JSON.parse(call.body)])).toEqual([
        ["/v1/grants", { names, ttlSeconds: 900, pin: PIN }],
      ]);
      expect(await status(id)).toBe("approved");
    });

    it.each([
      ["another order", ["B_KEY", "A_KEY"]],
      ["a subset", ["A_KEY"]],
      ["a superset", ["A_KEY", "B_KEY", "C_KEY"]],
    ])("answers 409 stale_request for %s than the approval holds", async (_label, names) => {
      const id = await askForSecret({ names: ["A_KEY", "B_KEY"], reason: "r" });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id, { names }));
      expect(response.status).toBe(409);
      expect(forwarded()).toEqual([]);
      expect(await status(id)).toBe("pending");
    });

    it("still takes the legacy single name, for a request and for an approval", async () => {
      const app = appFor(guardian);
      const legacy = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      const { names: _names, ...body } = grantBody(legacy);
      expect((await post(app, "/vault/grants", { ...body, name: "GITHUB_TOKEN" })).status).toBe(
        200,
      );
      const modern = await askForSecret({ names: ["GITHUB_TOKEN"], reason: "r" });
      const second = { ...body, approvalId: modern, name: "GITHUB_TOKEN" };
      expect((await post(app, "/vault/grants", second)).status).toBe(200);
      expect(forwarded().map((call) => JSON.parse(call.body).names)).toEqual([
        ["GITHUB_TOKEN"],
        ["GITHUB_TOKEN"],
      ]);
    });

    it("grants the length the request names", async () => {
      const id = await askForSecret({ name: "GITHUB_TOKEN", ttlMinutes: 60, reason: "r" });
      const app = appFor(guardian);
      const response = await post(app, "/vault/grants", grantBody(id, { ttlMinutes: 60 }));
      expect(response.status).toBe(200);
      expect(JSON.parse(forwarded()[0].body).ttlSeconds).toBe(3600);
    });

    it.each([
      ["another length", { ttlMinutes: 30 }],
      ["another name", { names: ["STRIPE_KEY"] }],
      ["an extra name", { names: ["GITHUB_TOKEN", "STRIPE_KEY"] }],
      ["no names", { names: [] }],
      ["names that are not text", { names: [1] }],
      ["no length", { ttlMinutes: undefined }],
      ["an unknown approval", { approvalId: "nope" }],
      ["no approval", { approvalId: undefined }],
    ])("answers 409 stale_request for %s, and forwards nothing", async (_label, over) => {
      const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id, over));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "This request changed or was already answered.",
        code: "stale_request",
      });
      expect(forwarded()).toEqual([]);
      expect(await status(id)).toBe("pending");
    });

    it("answers 409 stale_request when the approval is not a pending vault_apply", async () => {
      const repo = new ApprovalsRepository(testDb.db);
      const other = await askForSecret({ name: "GITHUB_TOKEN" }, "other:vault_apply");
      const answered = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      await repo.resolvePending(answered, "reject", "owner");
      const app = appFor(guardian);
      for (const id of [other, answered]) {
        expect((await post(app, "/vault/grants", grantBody(id))).status).toBe(409);
      }
      const generic = await repo.create({
        type: "outgoing_message",
        requestedBy: "agent",
        description: "x",
        payload: { actionName: "system:vault_apply", args: { name: "GITHUB_TOKEN" } },
      });
      expect((await post(app, "/vault/grants", grantBody(generic))).status).toBe(409);
      expect(forwarded()).toEqual([]);
      expect(await status(other)).toBe("pending");
      expect(await status(generic)).toBe("pending");
    });

    it("answers 409 stale_request when the secret is gone", async () => {
      signer.answers["POST /v1/grants"] = { status: 404, body: { error: "unknown_secret" } };
      const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id));
      expect(response.status).toBe(409);
      expect(await status(id)).toBe("pending");
    });

    it.each([
      [403, { error: "wrong_pin", attemptsLeft: 1 }],
      [423, { error: "locked", lockedUntil: "2026-11-16T10:15:00Z" }],
      [409, { error: "pin_not_set" }],
    ])("relays a %s from the signer and leaves the approval pending", async (code, body) => {
      signer.answers["POST /v1/grants"] = { status: code, body };
      const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id));
      expect(response.status).toBe(code);
      expect(await response.json()).toEqual(body);
      expect(await status(id)).toBe("pending");
      expect(approvalHandler.onApproved).not.toHaveBeenCalled();
    });

    it("answers 409 when the approval is answered between the check and the grant", async () => {
      const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      const repo = new ApprovalsRepository(testDb.db);
      signer.answers["POST /v1/grants"] = { status: 200, body: { ok: true } };
      const original = repo.findById.bind(repo);
      // The approval is pending when the route reads it and rejected before the route resolves it.
      rs.spyOn(ApprovalsRepository.prototype, "findById").mockImplementationOnce(async (key) => {
        const row = await original(key);
        await repo.resolvePending(key, "reject", "owner");
        return row;
      });
      const response = await post(appFor(guardian), "/vault/grants", grantBody(id));
      expect(response.status).toBe(409);
      expect(await status(id)).toBe("rejected");
    });
  });

  it("never lets the PIN reach the database or the logs", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    rs.spyOn(process.stdout, "write").mockImplementation(capture as never);
    rs.spyOn(process.stderr, "write").mockImplementation(capture as never);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      rs.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      });
    }
    try {
      const app = appFor(guardian);
      const id = await askForSecret({ name: "GITHUB_TOKEN", reason: "r" });
      await post(app, "/vault/pin", { pin: PIN });
      await app.request("/vault/GITHUB_TOKEN", {
        method: "PUT",
        headers: SAME_ORIGIN,
        body: JSON.stringify({ value: "v", pin: PIN }),
      });
      signer.answers["POST /v1/grants"] = { status: 403, body: { error: "wrong_pin" } };
      await post(app, "/vault/grants", grantBody(id));
      signer.answers["POST /v1/grants"] = { status: 200, body: { ok: true } };
      await post(app, "/vault/grants", grantBody(id));
      await post(app, "/vault/reset", { pin: PIN });
    } finally {
      rs.restoreAllMocks();
    }
    const rows = await new ApprovalsRepository(testDb.db).list();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(PIN);
    expect(written.join("\n")).not.toContain(PIN);
  });
});

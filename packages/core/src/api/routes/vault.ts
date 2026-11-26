import {
  VAULT_MAX_DESCRIPTION_LENGTH,
  VAULT_MAX_VALUE_LENGTH,
  vaultNameError,
} from "@rome/api-types/vault";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { request } from "node:http";
import { enteredPerson } from "../../access/require-entry.js";
import { signerSocketPath } from "../../instance/instance-identity.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";
import { approvalCall, resolveApproval, resolverOf, VAULT_APPLY_ACTION } from "./approvals.js";

const NO_SIGNER = "The vault needs the signer, which is not running on this instance.";
const SIGNER_OUTDATED = "The signer is too old for the vault. Upgrade the instance.";
const PIN_FAILED = "The vault could not set the PIN.";
const STALE_REQUEST = "This request changed or was already answered.";
/** The `vault` level that `GET /v1/health` reports once the signer checks the PIN. */
const SIGNER_VAULT_VERSION = 2;
/** The length `system:vault_apply` grants when the request names none. */
const DEFAULT_GRANT_MINUTES = 15;
// Signer answers about the PIN or the request. Any other failure becomes a
// 503, because Cloudflare replaces an origin 502 with a page of its own.
const SIGNER_ANSWER_STATUSES = new Set([400, 403, 409, 423]);

class NoSignerError extends Error {}
class SignerOutdatedError extends Error {}

type SignerReply = { status: number; body: unknown };

function signerCall(method: string, path: string, body?: unknown): Promise<SignerReply> {
  const socketPath = signerSocketPath();
  if (!socketPath) return Promise.reject(new NoSignerError(NO_SIGNER));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 502,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch {
          reject(new NoSignerError(NO_SIGNER));
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => reject(new NoSignerError(NO_SIGNER)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * Relays the signer's answer about the PIN or the request with its body, and
 * turns any other failure into a 503.
 */
function relayFailure(c: Context, reply: SignerReply, failure: string) {
  if (SIGNER_ANSWER_STATUSES.has(reply.status)) {
    return c.json(reply.body as object, reply.status as ContentfulStatusCode);
  }
  return c.json({ error: failure }, 503);
}

/** The secret names a request or approval arguments ask for: `names`, else the legacy `name`. */
function askedNames(source: Record<string, unknown>): string[] | null {
  const { names, name } = source;
  if (Array.isArray(names)) {
    return names.length > 0 && names.every((entry) => typeof entry === "string")
      ? (names as string[])
      : null;
  }
  return typeof name === "string" ? [name] : null;
}

// The vault's values and the PIN live in the signer, which alone checks the
// PIN. These routes forward the team's requests to its unix socket and keep
// nothing: no database row, no log line with a body, no process.env entry. The
// PIN passes through memory from the request body to the signer's.
export function vaultRoutes(deps: Pick<ApiDeps, "approvalHandler" | "approvalsRepo">): Hono {
  const app = new Hono();

  app.use("/vault/*", async (c, next) => {
    const actor = enteredPerson(c);
    const readOnly = ["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    // Only a browser session types a PIN. A loopback caller is any process in the container.
    if (
      !readOnly &&
      c.req.method !== "DELETE" &&
      actor.kind === "guardian" &&
      actor.via !== "cookie"
    )
      return c.json({ error: "Use the dashboard to change the vault." }, 403);
    if (!readOnly && !isSameOriginMutationRequest(c.req.raw))
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    // A signer that does not report the PIN would ignore it and grant anyway.
    const health = await signerCall("GET", "/v1/health");
    if ((health.body as { vault?: unknown } | null)?.vault !== SIGNER_VAULT_VERSION)
      throw new SignerOutdatedError(SIGNER_OUTDATED);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof NoSignerError) return c.json({ error: error.message }, 503);
    if (error instanceof SignerOutdatedError)
      return c.json({ error: error.message, code: "signer_outdated" }, 503);
    throw error;
  });

  app.get("/vault", async (c) => {
    const { status, body } = await signerCall("GET", "/v1/secrets");
    if (status !== 200) return c.json({ error: "The vault could not be read." }, 503);
    return c.json(body as object);
  });

  app.post("/vault/pin", async (c) => {
    const { pin } = await c.req.json<{ pin?: unknown }>().catch(() => ({}) as { pin?: unknown });
    const reply = await signerCall("POST", "/v1/pin", { pin });
    return reply.status === 200 ? c.json({ ok: true }) : relayFailure(c, reply, PIN_FAILED);
  });

  // A reset deletes every secret and replaces the PIN without the old one, and
  // the PIN is the guardian's credential, so a dashboard admin may not reset.
  app.post("/vault/reset", async (c) => {
    if (enteredPerson(c).kind !== "guardian")
      return c.json({ error: "Only the guardian can reset the vault." }, 403);
    const { pin } = await c.req.json<{ pin?: unknown }>().catch(() => ({}) as { pin?: unknown });
    const reply = await signerCall("POST", "/v1/reset", { pin });
    return reply.status === 200 ? c.json({ ok: true }) : relayFailure(c, reply, PIN_FAILED);
  });

  app.post("/vault/grants", async (c) => {
    const input = await c.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const { approvalId, ttlMinutes, pin } = input;
    const names = askedNames(input);
    const stale = () => c.json({ error: STALE_REQUEST, code: "stale_request" }, 409);
    if (typeof approvalId !== "string" || names === null || typeof ttlMinutes !== "number")
      return stale();
    // The card shows what the approval holds, so the grant must match it exactly.
    const approval = await deps.approvalsRepo.findById(approvalId);
    const { actionName, args } = approvalCall(approval);
    const approved = args === undefined ? null : askedNames(args);
    if (
      approval?.status !== "pending" ||
      approval.type !== "action_execution" ||
      actionName !== VAULT_APPLY_ACTION ||
      approved === null ||
      approved.join("\0") !== names.join("\0") ||
      (args?.ttlMinutes ?? DEFAULT_GRANT_MINUTES) !== ttlMinutes
    )
      return stale();
    const reply = await signerCall("POST", "/v1/grants", {
      names,
      ttlSeconds: ttlMinutes * 60,
      pin,
    });
    if (reply.status === 404) return stale();
    if (reply.status !== 200) {
      return relayFailure(c, reply, "The vault could not grant the secrets.");
    }
    const resolved = await resolveApproval(
      deps,
      approvalId,
      "approve",
      resolverOf(enteredPerson(c)),
    );
    return resolved.status === 202 ? c.json({ ok: true }) : c.json(resolved.body, resolved.status);
  });

  app.put("/vault/:name", async (c) => {
    const name = c.req.param("name");
    const nameError = vaultNameError(name);
    if (nameError) return c.json({ error: nameError }, 400);
    const input = await c.req
      .json<{ value?: unknown; description?: unknown; pin?: unknown }>()
      .catch(() => ({}) as { value?: unknown; description?: unknown; pin?: unknown });
    if (typeof input.value !== "string" || input.value.length === 0) {
      return c.json({ error: "Value is required." }, 400);
    }
    if (input.value.includes("\0")) {
      return c.json({ error: "Value must not contain a NUL character." }, 400);
    }
    if (input.value.length > VAULT_MAX_VALUE_LENGTH) {
      return c.json({ error: `Value must be at most ${VAULT_MAX_VALUE_LENGTH} characters.` }, 400);
    }
    if (input.description !== undefined && typeof input.description !== "string") {
      return c.json({ error: "Description must be text." }, 400);
    }
    if ((input.description?.length ?? 0) > VAULT_MAX_DESCRIPTION_LENGTH) {
      return c.json(
        { error: `Description must be at most ${VAULT_MAX_DESCRIPTION_LENGTH} characters.` },
        400,
      );
    }
    const reply = await signerCall("PUT", `/v1/secrets/${encodeURIComponent(name)}`, {
      value: input.value,
      description: input.description,
      pin: input.pin,
    });
    if (reply.status !== 200) return relayFailure(c, reply, "The vault could not save the secret.");
    return c.json({ ok: true });
  });

  app.delete("/vault/:name", async (c) => {
    const name = c.req.param("name");
    const { status } = await signerCall("DELETE", `/v1/secrets/${encodeURIComponent(name)}`);
    if (status === 404) return c.json({ error: "Unknown secret." }, 404);
    if (status !== 200) return c.json({ error: "The vault could not remove the secret." }, 503);
    return c.json({ ok: true });
  });

  return app;
}

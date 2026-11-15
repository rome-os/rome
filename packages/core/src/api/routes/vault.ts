import {
  VAULT_MAX_DESCRIPTION_LENGTH,
  VAULT_MAX_VALUE_LENGTH,
  vaultNameError,
} from "@rome/api-types/vault";
import { Hono } from "hono";
import { request } from "node:http";
import { currentSessionActor } from "../../access/session-actor.js";
import { signerSocketPath } from "../../instance/instance-identity.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";

const NO_SIGNER = "The vault needs the signer, which is not running on this instance.";

class NoSignerError extends Error {}

function signerCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
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

// The vault's values live in the signer. These routes forward the guardian's
// list, save and remove requests to its unix socket and keep nothing: no
// database row, no log line with a body, no process.env entry.
export function vaultRoutes(): Hono {
  const app = new Hono();

  app.use("/vault/*", async (c, next) => {
    if ((await currentSessionActor())?.kind !== "guardian")
      return c.json({ error: "Guardian authentication required" }, 403);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !isSameOriginMutationRequest(c.req.raw)
    )
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof NoSignerError) return c.json({ error: error.message }, 503);
    throw error;
  });

  app.get("/vault", async (c) => {
    const { status, body } = await signerCall("GET", "/v1/secrets");
    if (status !== 200) return c.json({ error: "The vault could not be read." }, 502);
    return c.json(body as object);
  });

  app.put("/vault/:name", async (c) => {
    const name = c.req.param("name");
    const nameError = vaultNameError(name);
    if (nameError) return c.json({ error: nameError }, 400);
    const input = await c.req
      .json<{ value?: unknown; description?: unknown }>()
      .catch(() => ({}) as { value?: unknown; description?: unknown });
    if (typeof input.value !== "string" || input.value.length === 0) {
      return c.json({ error: "Value is required." }, 400);
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
    const { status } = await signerCall("PUT", `/v1/secrets/${encodeURIComponent(name)}`, {
      value: input.value,
      description: input.description,
    });
    if (status !== 200) return c.json({ error: "The vault could not save the secret." }, 502);
    return c.json({ ok: true });
  });

  app.delete("/vault/:name", async (c) => {
    const name = c.req.param("name");
    const { status } = await signerCall("DELETE", `/v1/secrets/${encodeURIComponent(name)}`);
    if (status === 404) return c.json({ error: "Unknown secret." }, 404);
    if (status !== 200) return c.json({ error: "The vault could not remove the secret." }, 502);
    return c.json({ ok: true });
  });

  return app;
}

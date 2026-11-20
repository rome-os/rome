import { containerNodeCredentialSchema, containerNodeNameSchema } from "@rome/api-types/devices";
import { loginDeviceCode } from "@rome-os/node-core/host";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getGuardianAuthState } from "../../access/guardian-auth-state.js";
import { resolveGuardianSession } from "../../access/guardian-session.js";
import { proveIdentity } from "../../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../../instance/rome-cloud-origin.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { withTracingSuppressed } from "../../telemetry.js";
import type { ApiDeps } from "../deps.js";

const issueBody = z.object({ name: containerNodeNameSchema }).strict();

export function containerNodesRoutes(
  {
    db,
    nodeDevices,
  }: Pick<ApiDeps, "db"> & { nodeDevices: Pick<ApiDeps["nodeDevices"], "listDevices"> },
  cloud = { origin: getRomeCloudOrigin, prove: proveIdentity, login: loginDeviceCode },
) {
  const app = new Hono();
  app.post("/", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!isSameOriginMutationRequest(c.req.raw)) return c.json({ error: "sign_in_required" }, 403);
    const guardian = await resolveGuardianSession(c, db);
    const seat = await getGuardianAuthState(db);
    const account = seat.accountId;
    if (
      !account ||
      guardian?.via !== "cookie" ||
      guardian.userId !== account ||
      (seat.hasLocalPassword && guardian.userId === seat.userId)
    )
      return c.json({ error: "sign_in_required" }, 403);

    const input = issueBody.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_device_name" }, 400);
    const origin = cloud.origin();
    if (!origin) return c.json({ error: "not_configured" }, 409);
    const proof = await cloud.prove();
    if (proof.status === "no_token" || proof.status === "unconfigured")
      return c.json({ error: "not_configured" }, 409);
    if (
      proof.status === "revoked" ||
      proof.status === "unknown" ||
      (proof.status === "ok" && proof.identity.accountId !== account)
    )
      return c.json({ error: "sign_in_required" }, 403);
    if (proof.status !== "ok") return c.json({ error: "unavailable" }, 503);

    const response = streamSSE(c, async (stream) => {
      const connection = new AbortController();
      stream.onAbort(() => connection.abort());
      const signal = AbortSignal.any([connection.signal, c.req.raw.signal]);
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      const heartbeat = setInterval(() => void stream.write(": keepalive\n\n"), 15_000);
      const fail = (error: string) => send("authorization_error", { error });
      try {
        const session = await withTracingSuppressed(() =>
          cloud.login(origin, input.data.name, signal, ({ verificationUriComplete, userCode }) => {
            void send("authorization", { verificationUriComplete, userCode });
          }),
        );
        signal.throwIfAborted();
        const devices = await nodeDevices.listDevices();
        if (!devices) return await fail("unavailable");
        if (!devices.devices.some(({ id }) => id.toLowerCase() === session.deviceId.toLowerCase()))
          return await fail("approval_account_mismatch");
        if ((await getGuardianAuthState(db)).accountId !== account)
          return await fail("sign_in_required");
        signal.throwIfAborted();
        await send(
          "credential",
          containerNodeCredentialSchema.parse({
            origin: session.cloudUrl,
            deviceId: session.deviceId.toLowerCase(),
            deviceToken: session.token,
          }),
        );
      } catch {
        if (!signal.aborted) await fail("authorization_failed");
      } finally {
        clearInterval(heartbeat);
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return app;
}

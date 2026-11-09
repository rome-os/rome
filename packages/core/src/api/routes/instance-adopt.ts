import { Hono } from "hono";
import { getGuardianAuthState } from "../../lib/guardian-auth-state.js";
import {
  type AdoptedSlug,
  applyInstanceSlug,
  deriveInstanceOrigin,
  INSTANCE_SLUG_SETTING_KEY,
  isInstanceHosted,
  isInstanceSlug,
} from "../../instance/instance-env.js";
import {
  clearInstanceToken,
  isInstanceLinked,
  isValidInstanceToken,
  persistInstanceToken,
  signerMode,
} from "../../instance/instance-identity.js";
import { resolveInstanceSlug } from "../../instance/runtime.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:instance-adopt");

// A blank hosted instance (a warm-pool VM) receives its tenant identity here, at
// runtime, instead of through a rewritten `.env` and a restart. The request
// carries only the instance token; Rome links with it and takes the slug from
// Rome Cloud's whoami answer (`hostedSlug`), so the caller never picks the slug.
//
// The route is public at the auth layer (a blank box has no guardian to log in),
// so the token is the credential. A successful adopt needs an unregistered
// provisioned instance token, which only Pantheon holds, and the slug is not the
// caller's to choose. A token that is not a hosted one (say a caller's own
// desktop or browser instance) is undone and refused. Residual: such a caller can
// bind this VM's signer key to their instance first, so the legitimate claim then
// fails with key_conflict and the VM is quarantined. That wastes one warm VM,
// which sits behind the control-plane-only firewall anyway.
//
// A crash between the link and the slug record leaves a linked box without its
// slug. The control plane's call fails, so it quarantines the VM and never
// retries adopt on it; no recovery state is kept.

// Rome Cloud's verdict is final: retrying the same token will not help.
const TERMINAL_LINK_STATUSES: ReadonlySet<string> = new Set([
  "unknown",
  "revoked",
  "key_conflict",
  "upgrade_required",
]);

export interface InstanceAdoptSeams {
  persistInstanceToken?: typeof persistInstanceToken;
}

export function instanceAdoptRoutes(deps: ApiDeps, seams: InstanceAdoptSeams = {}): Hono {
  const app = new Hono();
  const persistToken = seams.persistInstanceToken ?? persistInstanceToken;
  // Two concurrent calls must not both pass the blank check.
  let adopting = false;

  app.post("/instance/adopt", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { instanceToken?: unknown } | null;
    const token = typeof body?.instanceToken === "string" ? body.instanceToken : null;
    if (!isValidInstanceToken(token)) return c.json({ error: "invalid_token" }, 400);
    if (!isInstanceHosted()) return c.json({ error: "not_hosted" }, 409);
    // Without a signer the token is only stored, never presented to Rome Cloud,
    // so nothing would confirm it is a hosted instance's.
    if (!signerMode()) return c.json({ error: "signer_required" }, 409);

    if (adopting) return c.json({ error: "not_blank" }, 409);
    adopting = true;
    try {
      if (isInstanceLinked() || (await getGuardianAuthState(deps.db)).exists) {
        return c.json({ error: "not_blank" }, 409);
      }

      // Link first: the token is only as good as Rome Cloud's answer to it.
      let linked: Awaited<ReturnType<typeof persistInstanceToken>>;
      try {
        linked = await persistToken(deps.settingsRepo, token);
      } catch (err) {
        await clearInstanceToken(deps.settingsRepo);
        log.error("instance adopt failed to link", {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "adopt_failed" }, 500);
      }
      if (!linked || linked.status !== "ok") {
        await clearInstanceToken(deps.settingsRepo);
        const status = linked?.status ?? "no_token";
        log.warn("instance adopt failed to link", { status });
        return c.json(
          { error: "link_failed", status },
          TERMINAL_LINK_STATUSES.has(status) ? 409 : 502,
        );
      }

      // Rome Cloud names the slug, and only for a provisioned credential.
      const slug = linked.identity.hostedSlug;
      if (!isInstanceSlug(slug)) {
        await clearInstanceToken(deps.settingsRepo);
        log.warn("instance adopt refused a token that is not a hosted instance's");
        return c.json({ error: "not_hosted_instance" }, 409);
      }
      const origin = deriveInstanceOrigin(slug);
      if (!origin) return c.json({ error: "not_hosted" }, 409);

      const previous = resolveInstanceSlug() ?? null;
      const record: AdoptedSlug = { from: previous, to: slug };
      try {
        await deps.settingsRepo.set(INSTANCE_SLUG_SETTING_KEY, record);
      } catch (err) {
        await clearInstanceToken(deps.settingsRepo);
        log.error("instance adopt failed to store the slug", {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "adopt_failed" }, 500);
      }

      applyInstanceSlug(slug);
      try {
        // New workers fork with the new env and load their own config.
        await deps.actionEngine.restartWorkerWarmPool();
      } catch (err) {
        log.warn("worker restart after adopt failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      void deps.provisionAfterLink?.();
      log.info("instance adopted", { from: previous, to: slug });
      return c.json({ ok: true, slug, origin });
    } finally {
      adopting = false;
    }
  });

  return app;
}

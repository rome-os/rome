import { Hono } from "hono";
import { getGuardianAuthState } from "../../lib/guardian-auth-state.js";
import {
  applyInstanceSlug,
  deriveInstanceOrigin,
  INSTANCE_SLUG_SETTING_KEY,
  isInstanceSlug,
} from "../../lib/instance-env.js";
import {
  clearInstanceToken,
  isInstanceLinked,
  isValidInstanceToken,
  persistInstanceToken,
} from "../../lib/instance-identity.js";
import { resolveInstanceSlug } from "../../lib/runtime.js";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:instance-adopt");

// A blank hosted instance (a warm-pool VM) receives its tenant identity here,
// at runtime, instead of through a rewritten `.env` and a restart. The caller is
// the control plane on the VM host; there is no guardian yet, so the route is
// public (see PUBLIC_API_PATHS in auth.ts) and refuses anything but a blank,
// unlinked, hosted instance. That refusal is the boundary: this can never
// re-bind an instance that has an owner or a link.

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
    const body = (await c.req.json().catch(() => null)) as {
      slug?: unknown;
      instanceToken?: unknown;
    } | null;
    const slug = body?.slug;
    const token = typeof body?.instanceToken === "string" ? body.instanceToken : null;
    if (!isInstanceSlug(slug)) return c.json({ error: "invalid_slug" }, 400);
    if (!isValidInstanceToken(token)) return c.json({ error: "invalid_token" }, 400);
    const origin = deriveInstanceOrigin(slug);
    if (!origin) return c.json({ error: "not_hosted" }, 409);

    if (adopting) return c.json({ error: "not_blank" }, 409);
    adopting = true;
    try {
      if (isInstanceLinked() || (await getGuardianAuthState(deps.db)).exists) {
        return c.json({ error: "not_blank" }, 409);
      }

      // All or nothing: the token first (signer mode registers the key), undone
      // if the link fails, and only then the slug.
      const linked = await persistToken(deps.settingsRepo, token);
      if (linked && linked.status !== "ok") {
        await clearInstanceToken(deps.settingsRepo);
        log.warn("instance adopt failed to link", { status: linked.status });
        const status = TERMINAL_LINK_STATUSES.has(linked.status) ? 409 : 502;
        return c.json({ error: "link_failed", status: linked.status }, status);
      }

      try {
        await deps.settingsRepo.set(INSTANCE_SLUG_SETTING_KEY, slug);
      } catch (err) {
        await clearInstanceToken(deps.settingsRepo);
        log.error("instance adopt failed to store the slug", {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "adopt_failed" }, 500);
      }

      const previous = resolveInstanceSlug();
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
      log.info("instance adopted", { from: previous ?? null, to: slug });
      return c.json({ ok: true, slug, origin });
    } finally {
      adopting = false;
    }
  });

  return app;
}

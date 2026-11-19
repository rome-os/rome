import type { Context } from "hono";
import type { DrizzleDb } from "../db/index.js";
import { isSameOriginMutationRequest } from "../lib/mutation-origin.js";
import { getGuardianAuthState } from "./guardian-auth-state.js";
import { resolveGuardianSession } from "./guardian-session.js";

export async function containerNodeGuardian(c: Context, db: DrizzleDb, local: boolean) {
  const session = await resolveGuardianSession(c, db);
  if (session?.via !== "cookie") return null;
  if (c.req.method !== "GET" && !isSameOriginMutationRequest(c.req.raw)) return null;
  const seat = await getGuardianAuthState(db);
  const localLogin = seat.hasLocalPassword && session.userId === seat.userId;
  // A local password user might have the same name as a Cloud account ID.
  const cloudLogin = !localLogin && session.userId === seat.accountId;
  if (local) return localLogin || cloudLogin ? seat.id : null;
  return cloudLogin ? session.userId : null;
}

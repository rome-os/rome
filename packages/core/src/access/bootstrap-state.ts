import type { BootstrapState } from "@rome/api-types";
import type { DrizzleDb } from "../db/index.js";
import { getGuardianAuthState } from "./guardian-auth-state.js";

export interface BootstrapInputs {
  // The resolved cloud-auth decision (from the `rome_cloud_auth` rollout gate) —
  // cloud guardian sign-in is enabled.
  cloudAuthEnabled: boolean;
  // A Rome Cloud origin is configured, so cloud enroll/sign-in is reachable.
  romeCloudConfigured: boolean;
  // This instance holds a durable instance token.
  instanceEnrolled: boolean;
  // The request carries a valid guardian session (cookie or trusted loopback).
  hasSession: boolean;
  // The dashboard has a Rome Cloud email allow-list, so login can offer the
  // visitor sign-in path in addition to guardian sign-in.
  dashboardVisitorAccessEnabled?: boolean;
}

// The single, server-side computation of the SPA bootstrap lifecycle, decided
// once and named as one `BootstrapState`. The ordering matters: cloud-default
// boxes sign in first (sign-in subsumes enrollment + seat creation),
// local-first boxes walk enroll -> account -> sign-in -> onboard.
export async function resolveBootstrapState(
  db: DrizzleDb,
  inputs: BootstrapInputs,
): Promise<BootstrapState> {
  const {
    cloudAuthEnabled,
    romeCloudConfigured,
    instanceEnrolled,
    hasSession,
    dashboardVisitorAccessEnabled = false,
  } = inputs;
  const cloudDefault = cloudAuthEnabled && romeCloudConfigured;
  const guardian = await getGuardianAuthState(db);

  function needsSignin(state: Extract<BootstrapState, { phase: "needs-signin" }>) {
    return dashboardVisitorAccessEnabled ? { ...state, dashboardVisitorAccess: true } : state;
  }

  // Fully provisioned with a live session — the only `ready` gate. Onboarded but
  // session-less (expired) deliberately falls through to a re-auth below.
  if (guardian.exists && guardian.onboardingComplete && hasSession) {
    return { phase: "ready" };
  }

  if (cloudDefault) {
    // Cloud sign-in is the account source: it enrolls the box, binds the
    // account, and creates the seat in one round trip, so the only gates are the
    // session and onboarding completion.
    if (!hasSession) {
      return needsSignin({
        phase: "needs-signin",
        method: "cloud",
        localPasswordAvailable: guardian.hasLocalPassword,
      });
    }
    return { phase: "needs-onboarding" };
  }

  if (romeCloudConfigured && !instanceEnrolled) {
    return { phase: "unenrolled" };
  }
  if (!guardian.exists) {
    return { phase: "needs-account" };
  }
  if (!hasSession) {
    return needsSignin({ phase: "needs-signin", method: "local" });
  }
  return { phase: "needs-onboarding" };
}

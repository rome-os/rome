// Typed Rome Cloud self-upgrade client used by SystemUpgradeService.
//
// This is the service-side twin of the dashboard relay in
// `api/routes/system-upgrade.ts`: the route mirrors Rome Cloud's status + body
// verbatim back to the manual settings UI, whereas this client narrows the
// same two endpoints to the typed results the nightly probe + cutover need.
// Both speak the instance-token contract and self-reject on an
// unversioned build (no release identity to compare against Rome Cloud's latest).

import { getBuildInfo } from "../../build-info.js";
import { cloudBearer } from "../instance-identity.js";
import { getRomeCloudOrigin } from "../rome-cloud-origin.js";

const ROME_CLOUD_TIMEOUT_MS = 15_000;

export interface UpgradeCheck {
  current: { version: string | null; sha: string | null };
  latest: { version: string };
  upgradeAvailable: boolean;
}

export type CheckResult = { ok: true; data: UpgradeCheck } | { ok: false; error: string };

export type ApplyResult = { ok: true } | { ok: false; error: string };

async function romeCloudAccess(): Promise<{ origin: string; token: string } | null> {
  const token = await cloudBearer();
  const origin = getRomeCloudOrigin();
  if (!token || !origin) return null;
  return { origin, token };
}

/** Ask Rome Cloud whether a newer release is pending for this instance. Mirrors
 * the preconditions of the dashboard relay: an unversioned build has no
 * comparable identity, and Rome Cloud must be reachable + configured. */
export async function checkUpgrade(): Promise<CheckResult> {
  const build = getBuildInfo();
  if (!build.version) return { ok: false, error: "unversioned_build" };

  const romeCloud = await romeCloudAccess();
  if (!romeCloud) return { ok: false, error: "pantheon_unconfigured" };

  const url = new URL("/api/instance/upgrade/check", romeCloud.origin);
  url.searchParams.set("version", build.version);
  url.searchParams.set("sha", build.sha ?? "");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${romeCloud.token}`, "Cache-Control": "no-store" },
      cache: "no-store",
      signal: AbortSignal.timeout(ROME_CLOUD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "pantheon_unreachable" };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    const error =
      body !== null &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "pantheon_unreachable";
    return { ok: false, error };
  }
  if (!isUpgradeCheck(body)) return { ok: false, error: "pantheon_unreachable" };
  return { ok: true, data: body };
}

/** Relay the apply request to Rome Cloud, which orchestrates the restart. A 200
 * means Rome Cloud has accepted the cutover and will replace this process. */
export async function applyUpgrade(target: string): Promise<ApplyResult> {
  if (!getBuildInfo().version) return { ok: false, error: "unversioned_build" };

  const romeCloud = await romeCloudAccess();
  if (!romeCloud) return { ok: false, error: "pantheon_unconfigured" };

  let response: Response;
  try {
    response = await fetch(new URL("/api/instance/upgrade", romeCloud.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${romeCloud.token}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      cache: "no-store",
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(ROME_CLOUD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "pantheon_unreachable" };
  }

  if (response.ok) return { ok: true };
  const body: unknown = await response.json().catch(() => null);
  const error =
    body !== null &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `pantheon_status_${response.status}`;
  return { ok: false, error };
}

function isUpgradeCheck(body: unknown): body is UpgradeCheck {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  const latest = b.latest as Record<string, unknown> | undefined;
  return (
    typeof b.upgradeAvailable === "boolean" &&
    typeof latest === "object" &&
    latest !== null &&
    typeof latest.version === "string"
  );
}

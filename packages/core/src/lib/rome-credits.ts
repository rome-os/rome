import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

const REQUEST_TIMEOUT_MS = 10_000;

/** Rome Cloud could not be asked, or answered with something other than a balance. */
export class RomeCreditsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RomeCreditsUnavailableError";
  }
}

function isMicros(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

/**
 * Read the account's Rome credits from the Rome Cloud inference gateway.
 *
 * Returns null when there are no credits to show: the instance is not signed
 * in to Rome Cloud, Rome Cloud rejects its credential, or the account was
 * never granted credits (accounts created before the signup grant). Throws
 * {@link RomeCreditsUnavailableError} when Rome Cloud cannot be reached or
 * answers unexpectedly, so a transient outage is not mistaken for "no credits".
 */
export async function fetchRomeCredits(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RomeCreditsView | null> {
  const token = getInstanceToken();
  const origin = getRomeCloudOrigin();
  if (!token || !origin) return null;

  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/inference/usage", origin), {
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RomeCreditsUnavailableError(
      `Rome credits request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // 401 unknown and 403 revoked instance credentials: not signed in.
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new RomeCreditsUnavailableError(`Rome credits request failed with ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !body ||
    !isMicros(body.grantedMicros) ||
    !isMicros(body.balanceMicros) ||
    !isMicros(body.availableMicros) ||
    typeof body.enabled !== "boolean"
  ) {
    throw new RomeCreditsUnavailableError("Rome credits response was malformed");
  }
  if (BigInt(body.grantedMicros) <= 0n) return null;
  return {
    grantedMicros: body.grantedMicros,
    balanceMicros: body.balanceMicros,
    availableMicros: body.availableMicros,
    enabled: body.enabled,
  };
}

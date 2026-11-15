import type { SharedPosition } from "@rome/api-types/location-card";

/** Why the browser gave no position: the guardian or the browser refused it,
 *  it could not get a fix in time, or it cannot read a position at all. */
export type PositionFailure = "denied" | "unavailable" | "unsupported";

/**
 * Reads the device's position once, as the share-location card sends it. The
 * browser asks the guardian for permission the first time. A fix up to a
 * minute old is good enough.
 */
export function readDevicePosition(
  geolocation: Geolocation | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.geolocation,
): Promise<{ ok: true; position: SharedPosition } | { ok: false; failure: PositionFailure }> {
  if (!geolocation) return Promise.resolve({ ok: false, failure: "unsupported" });
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (fix) =>
        resolve({
          ok: true,
          position: {
            latitude: fix.coords.latitude,
            longitude: fix.coords.longitude,
            accuracy: fix.coords.accuracy,
            timestamp: fix.timestamp,
          },
        }),
      (error) =>
        resolve({
          ok: false,
          failure: error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

/**
 * Whether the browser already lets this site read the position (`granted`),
 * refuses it (`denied`), or will ask (`prompt`). A browser that cannot say
 * reads as `prompt`, so the card asks on Share.
 */
export async function geolocationPermission(): Promise<PermissionState> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    return status?.state ?? "prompt";
  } catch {
    return "prompt";
  }
}

/** The accuracy radius as the answered card shows it: meters under a
 *  kilometer, whole kilometers above. */
export function formatAccuracy(meters: number): string {
  return meters < 1_000 ? `${Math.round(meters)} m` : `${Math.round(meters / 1_000)} km`;
}

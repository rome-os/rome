import type { AppRemixSource, AppRemixStorePin } from "@rome/api-types/apps";
import { parseListingId } from "@rome-os/app-runtime/packaging";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStorePin(value: unknown): AppRemixStorePin | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.listingId !== "string" ||
    !parseListingId(value.listingId) ||
    typeof value.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version) ||
    typeof value.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.contentHash)
  ) {
    return null;
  }
  return {
    listingId: value.listingId,
    version: value.version,
    contentHash: value.contentHash.toLowerCase(),
  };
}

/** Validate RPC and direct callers before any Remix filesystem or network work. */
export function parseRemixSource(value: unknown): AppRemixSource | null {
  if (!isRecord(value)) return null;
  if (!("appId" in value)) return parseStorePin(value);
  if (
    typeof value.appId !== "string" ||
    value.appId.length === 0 ||
    Object.keys(value).some((key) => key !== "appId" && key !== "expectedSource")
  ) {
    return null;
  }
  if (value.expectedSource === undefined) return { appId: value.appId };
  const expectedSource = parseStorePin(value.expectedSource);
  return expectedSource ? { appId: value.appId, expectedSource } : null;
}

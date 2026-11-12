import { isValidAppId } from "./packaging/app-id.js";

export class InvalidAppApiPathError extends Error {}

export function decodeAppApiPathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new InvalidAppApiPathError(`Invalid app API route segment "${segment}"`);
  }

  if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
    throw new InvalidAppApiPathError(`Invalid app API route segment "${segment}"`);
  }

  return decoded;
}

/** Decode one route segment that must contain a complete canonical app id. */
export function decodeAppIdPathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new InvalidAppApiPathError(`Invalid app id route segment "${segment}"`);
  }

  if (!isValidAppId(decoded)) {
    throw new InvalidAppApiPathError(`Invalid app id route segment "${segment}"`);
  }
  return decoded;
}

export function decodeAppApiPath(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeAppApiPathSegment(segment));
}

/**
 * RFC 4122 v4 UUID that also works outside secure contexts.
 *
 * `crypto.randomUUID()` exists only in secure contexts (HTTPS or localhost),
 * so a dashboard served over plain HTTP on a LAN/container IP throws on it.
 * `crypto.getRandomValues()` is available in every context, so fall back to it.
 * Browser code must call this instead of `crypto.randomUUID()` directly.
 */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { createHash } from "node:crypto";

/** Cloud accepts at most 128 path-safe characters. The header always retains the original session id. */
export function traceArchiveSessionKey(sessionId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) && !sessionId.startsWith("encoded_"))
    return sessionId;
  const encoded = `encoded_b64_${Buffer.from(sessionId, "utf8").toString("base64url")}`;
  return encoded.length <= 128
    ? encoded
    : `encoded_sha256_${createHash("sha256").update(sessionId).digest("hex")}`;
}

export function traceArchiveRelativePath(sessionId: string, archiveId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(archiveId)) throw new Error("Invalid trace archive id");
  return `${traceArchiveSessionKey(sessionId)}/${archiveId}.jsonl.gz`;
}

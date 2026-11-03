import { homedir } from "os";
import { join } from "path";
import { app, shell } from "electron";
import { z } from "zod";
import { AuditStore, type ContentName } from "@rome-os/node-core/host";
import { handleTrusted } from "./ipc-trust";

/** The app's own log, next to its settings database. `rome-node connect` keeps a separate one. */
const AUDIT_PATH = join(homedir(), ".rome-desktop", "audit", "audit.db");

/** What a caller this Mac refused is told to do. */
const DESKTOP_AUDIT_HINT = "Open Rome → Audit Log… on that Mac.";

/** The detail view shows this much of a payload. */
const PREVIEW_BYTES = 256 * 1024;

/** Never throws: an unavailable log only makes this computer refuse remote requests. */
export function openAudit(): Promise<AuditStore> {
  return AuditStore.open({
    path: AUDIT_PATH,
    entry: "desktop",
    hint: DESKTOP_AUDIT_HINT,
    version: app.getVersion(),
  });
}

const contentName = z.enum(["stdin", "stdout", "stderr", "file"]);
const seq = z.number().int().positive();
const query = z
  .object({
    beforeSeq: seq.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    since: z.number().optional(),
    until: z.number().optional(),
    action: z.string().optional(),
    outcome: z.enum(["ok", "exit_nonzero", "error", "interrupted", "no_end"]).optional(),
    text: z.string().optional(),
    requestsOnly: z.boolean().optional(),
    result: z.enum(["succeeded", "failed", "no_result"]).optional(),
  })
  .strict();

/**
 * The audit window's channels. Only the app's own `file:` pages may call them, and the
 * preload hands `audit` to those pages only, so a Rome or any other site in the main window
 * cannot read the log.
 */
export function registerAuditHandlers(audit: AuditStore): void {
  handleTrusted("audit:status", async () => {
    await audit.status();
    return audit.summary();
  });
  handleTrusted("audit:list", (_event, value) => audit.list(query.parse(value ?? {})));
  handleTrusted("audit:get", (_event, value) => audit.get(seq.parse(value)));
  handleTrusted("audit:counts", () => audit.resultCounts());
  handleTrusted("audit:stats", (_event, ...args) => {
    const [since, until, bucketMs] = z
      .tuple([z.number(), z.number(), z.number().int().min(60_000)])
      .parse(args);
    return audit.stats(since, until, bucketMs);
  });
  handleTrusted("audit:content", (_event, ...args) => {
    const [at, name] = z.tuple([seq, contentName]).parse(args);
    const data = audit.content(at, name as ContentName);
    return data
      ? { size: data.byteLength, preview: new Uint8Array(data.subarray(0, PREVIEW_BYTES)) }
      : null;
  });
  handleTrusted("audit:reveal", () => shell.showItemInFolder(audit.path));
}

// Frames the Discord gateway Worker deposits into the instance's own relay
// mailbox, picked out of that mailbox's drain. The mailbox otherwise serves an
// app's webhooks, so a Discord frame never fails in a way that holds those up
// for good: with the bot off it is dropped, and one its connection could not
// take yet is delivered again.

import type { ConnectionRegistry } from "../../registry.js";
import { DISCORD_DEPOSIT_HEADER, DISCORD_SIGNATURE_HEADER } from "./adapter.js";
import { DISCORD_APP_KIND } from "./descriptor.js";

/** A header of a drained frame, whatever its case. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** Whether a drained frame is one the Discord gateway Worker deposited. */
export function isDiscordFrame(headers: Record<string, string>): boolean {
  return headerOf(headers, DISCORD_DEPOSIT_HEADER) === "1";
}

/** Hands a Discord frame to Rome's Discord bot connection, answering an HTTP
 *  status the drain acts on. */
export async function deliverDiscordFrame(
  registry: Pick<ConnectionRegistry, "all" | "ingest">,
  frame: { headers: Record<string, string>; body: Uint8Array | null },
): Promise<{ status: number }> {
  const conn = registry.all().find((c) => c.connectionKind === DISCORD_APP_KIND);
  if (!conn) return { status: 200 };
  try {
    const result = (await registry.ingest(conn.id, {
      body: frame.body ?? new Uint8Array(0),
      signature: headerOf(frame.headers, DISCORD_SIGNATURE_HEADER) ?? "",
    })) as { status?: unknown } | null;
    return { status: typeof result?.status === "number" ? result.status : 200 };
  } catch {
    return { status: 503 };
  }
}

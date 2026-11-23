// Frames the Discord gateway Worker deposits into the instance's own relay
// mailbox, picked out of that mailbox's drain. The mailbox otherwise serves an
// app's webhooks, and it holds every later frame behind one it is asked to
// deliver again, so a Discord frame is never answered with a failure of ours:
// with the bot off, or its connection not running, it is dropped and logged.
// Only a frame that is no valid deposit is refused.

import { createLogger } from "../../../logger.js";
import type { ConnectionRegistry } from "../../registry.js";
import { DISCORD_DEPOSIT_HEADER, DISCORD_SIGNATURE_HEADER } from "./adapter.js";
import { DISCORD_APP_KIND } from "./descriptor.js";

const log = createLogger("discord-app");

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
  if (!conn) {
    log.warn("discord frame dropped: Rome's Discord bot is not connected");
    return { status: 200 };
  }
  try {
    const result = (await registry.ingest(conn.id, {
      body: frame.body ?? new Uint8Array(0),
      signature: headerOf(frame.headers, DISCORD_SIGNATURE_HEADER) ?? "",
    })) as { status?: unknown } | null;
    return { status: typeof result?.status === "number" ? result.status : 200 };
  } catch (error) {
    // No ingress: the connection is relocked, needs fixing or is stopping.
    log.error("discord frame dropped: the connection is not running", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 200 };
  }
}

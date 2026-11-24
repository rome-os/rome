// Starting a connection's setup for one grant, as the Connections page's
// Connect does (`POST /api/connections/:id/grants/:name/setup`) and as core's
// connect card does in the chat. Vocabulary: docs/domains/connections.md#grant.

import { createLogger } from "../../logger.js";
import type { ConnectionRegistry } from "../registry.js";
import { isUnconnectedAccount } from "../unconnected-accounts.js";
import { NoSetupError, type SetupManager, type SetupStart, type SetupTarget } from "./manager.js";

const log = createLogger("setups");

/** What starting a setup comes to: the setup started or re-attached, or why
 *  none started, with the HTTP status the Connections page reads it as. */
export type SetupStartOutcome =
  | { status: "started"; started: SetupStart }
  | { status: "refused"; code: 400 | 404 | 409; error: string };

/**
 * Starts the setup for `grant` of what `idOrKind` addresses, or re-attaches to
 * the one running there. `idOrKind` is a connection id, or a connection kind
 * the guardian never connected; with `another`, a kind that offers several
 * accounts, for a new one. `force` cancels a live setup and starts a fresh
 * one. A connection a failed removal left behind is removed first and refused,
 * so no setup connects into its old account.
 */
export async function startConnectionSetup(
  deps: { registry: ConnectionRegistry; manager: SetupManager },
  request: { idOrKind: string; grant: string; force?: boolean; another?: boolean },
): Promise<SetupStartOutcome> {
  const { registry, manager } = deps;
  const { idOrKind, grant, force = false, another = false } = request;
  const target = resolveTarget(registry, idOrKind, another);
  if (!target) {
    return another
      ? { status: "refused", code: 400, error: `"${idOrKind}" does not offer another account.` }
      : { status: "refused", code: 404, error: "Unknown connection." };
  }
  // Checked before anything below touches the account, so a start for a
  // grant with no setup changes nothing.
  const descriptor = registry.getDescriptor(target.connectionKind);
  if (descriptor?.grant !== grant || !descriptor.auth.setup) {
    return { status: "refused", code: 404, error: "No setup for this grant." };
  }
  // An account that connects again starts fresh, so the card of a
  // disconnected account offers no setup into it. Its card goes on the next
  // refresh, and the connection kind's own Connect starts the new account.
  if (target.connectionId) {
    const leftover = await removeLeftoverAccount(
      registry,
      target.connectionKind,
      target.connectionId,
      grant,
    );
    if (leftover === "gone") {
      return {
        status: "refused",
        code: 409,
        error: "This account was disconnected. Connect it again from Connections.",
      };
    }
    if (leftover === "stuck") {
      return {
        status: "refused",
        code: 409,
        error:
          "Rome could not clear this disconnected account. Restart Rome, then connect it again.",
      };
    }
  }
  try {
    return { status: "started", started: await manager.start(target, grant, { force }) };
  } catch (err) {
    if (err instanceof NoSetupError) {
      return { status: "refused", code: 404, error: "No setup for this grant." };
    }
    throw err;
  }
}

/** Resolve what a setup start addresses. `:id` is either a live connection id
 *  (carry the id AND its connection kind so the terminal write imports into THAT
 *  connection) or, for a never-connected connection kind, the bare connection kind — valid
 *  only when a descriptor is registered for it (placeholder; the write mints the
 *  row). With `another`, `:id` must name a connection kind that offers several
 *  accounts, and the write mints a new one. Null when none of these. */
function resolveTarget(
  registry: ConnectionRegistry,
  id: string,
  another: boolean,
): SetupTarget | null {
  if (another) {
    return registry.getDescriptor(id)?.severalAccounts === true
      ? { connectionKind: id, another: true }
      : null;
  }
  const conn = registry.all().find((c) => c.id === id);
  if (conn) return { connectionKind: conn.connectionKind, connectionId: conn.id };
  return registry.isRegistered(id) ? { connectionKind: id } : null;
}

/** Remove `connectionId` when it is an account a failed removal left behind,
 *  so no setup connects into its old channel. Answers "kept" for an account
 *  still connected, "gone" once it is removed (now, or by a disconnect that
 *  ran first), and "stuck" when the removal fails again, which leaves it for
 *  the boot pass. */
async function removeLeftoverAccount(
  registry: ConnectionRegistry,
  connectionKind: string,
  connectionId: string,
  grant: string,
): Promise<"kept" | "gone" | "stuck"> {
  return registry.withGrantSection(connectionKind, grant, async () => {
    const conn = registry.all().find((held) => held.id === connectionId);
    if (!conn) return "gone";
    if (!(await isUnconnectedAccount(registry, conn))) return "kept";
    try {
      await registry.remove(connectionId);
    } catch (error) {
      log.warn("could not remove a disconnected account before its setup", { connectionId, error });
      return "stuck";
    }
    return "gone";
  });
}

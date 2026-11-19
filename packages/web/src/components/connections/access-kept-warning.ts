import { toast } from "sonner";
import type { TeardownResult } from "@/lib/connections-api";

/** Tell the guardian when a disconnect ended the connection in Rome but the
 *  service may still hold Rome's access. A toast stays until dismissed, since
 *  the card that ran the disconnect often goes away with the account. */
export function warnIfAccessKept(result: TeardownResult): void {
  if (result.ok && result.warning) {
    toast.warning(result.warning, { duration: Number.POSITIVE_INFINITY, closeButton: true });
  }
}

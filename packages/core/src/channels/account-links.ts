// Which kinds of connection take an agent, and as which kind of link, read
// from each kind's descriptor. Vocabulary: docs/domains/chats.md#connected-account.

import type { AccountLink } from "@rome/api-types/account-agents";
import type { ConnectionRegistry } from "../connections/registry.js";

/** The kind of link an agent has to an account of `connectionKind`, or null
 *  when that kind takes no agent or is not registered. */
export type AccountLinkOf = (connectionKind: string) => AccountLink | null;

/** The {@link AccountLinkOf} the registry's descriptors declare, read on each
 *  call. With no registry, no kind takes an agent. */
export function accountLinkOf(
  registry: Pick<ConnectionRegistry, "getDescriptor"> | undefined,
): AccountLinkOf {
  return (connectionKind) => registry?.getDescriptor(connectionKind)?.link ?? null;
}

/** For a caller that never claims, releases or links a channel, such as the
 *  action worker, which reads only which kind a channel is. */
export const noAccountLinks: AccountLinkOf = () => null;

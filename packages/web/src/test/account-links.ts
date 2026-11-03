import type { AccountLink } from "@rome/api-types/account-agents";

/** The kind of link core reports for each built-in kind of connection, for
 *  fixtures that stand in for `GET /api/connections`. Core declares it on each
 *  kind's descriptor. */
export function linkOf(connectionKind: string): AccountLink | null {
  if (connectionKind === "telegram_user") return "delegate";
  return ["feishu", "telegram", "discord", "slack_bot"].includes(connectionKind)
    ? "own_account"
    : null;
}

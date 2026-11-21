// The dashboard's side of Chats' send (`chats/send.ts`). Rome is the
// dashboard's platform, so a send there is said as an agent's dashboard
// account and wakes the chat's agent, the way the guardian's composer does.

import type { Account } from "@rome-os/app-runtime";
import type { Body, PlatformSend } from "../chats/send.js";
import { DASHBOARD_PLATFORM } from "./dashboard-account.js";

/**
 * Where a send into a dashboard chat goes. Rome is the dashboard's platform,
 * so there is nobody else to ask: the message is said once it is recorded,
 * and the chat's agent wakes on it as it does on the guardian's. Each agent
 * has its own account there, named by the agent's id.
 */
export interface DashboardInbox {
  post(
    chatId: string,
    body: Body,
    as: Account,
  ): Promise<{ ok: true; messageId: string; at: Date } | { ok: false; error: string }>;
}

/**
 * The dashboard's side of a send, posting into `inbox`. A send names the
 * agent account that says it, since every agent holds one there and none is
 * the dashboard's only one. A dashboard chat has no threads. Absent `inbox`,
 * the dashboard takes no sends.
 */
export function dashboardSend(inbox?: DashboardInbox): PlatformSend {
  return async (place, body, as) => {
    if (as === undefined || "channel" in as || as.platform !== DASHBOARD_PLATFORM) {
      return {
        ok: false,
        invalid: "A send into a dashboard chat names the agent account it is from",
      };
    }
    if (place.threadId !== undefined) {
      return { ok: false, invalid: "A dashboard chat has no threads" };
    }
    if (!inbox) return { ok: false, send: "unsupported" };
    const posted = await inbox.post(place.chat.id, body, as);
    if (!posted.ok) {
      return {
        ok: false,
        error: posted.error,
        delivery: { state: "failed", error: posted.error, at: new Date() },
      };
    }
    return {
      ok: true,
      sent: {
        ref: `${place.chat.id}:${posted.messageId}`,
        timestamp: Math.floor(posted.at.getTime() / 1000),
      },
      delivery: { state: "sent", at: posted.at },
    };
  };
}

/** The platforms Rome serves itself, with the dashboard posting into `inbox`. */
export function ownPlatforms(inbox?: DashboardInbox): ReadonlyMap<string, PlatformSend> {
  return new Map([[DASHBOARD_PLATFORM, dashboardSend(inbox)]]);
}

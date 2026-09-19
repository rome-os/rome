import type { ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import type { ConnectionTalkRouter } from "../connections/talk-router.js";
import type { ExactOriginRoute, ExactOriginTransport } from "./service.js";

/**
 * Core-owned adapter that is intentionally narrower than TalkRouter. App code
 * never receives this object or raw route coordinates; OriginMessagingService
 * is its only caller.
 */
export class TalkExactOriginTransport implements ExactOriginTransport {
  constructor(private readonly talkRouter: ConnectionTalkRouter) {}

  async preflight(route: ExactOriginRoute): Promise<"available" | "unavailable"> {
    return this.talkRouter.exactOriginAvailable(route.connectionId, route.service)
      ? "available"
      : "unavailable";
  }

  async send(route: ExactOriginRoute, text: string): Promise<MessageReceipt> {
    return await this.talkRouter.send(route.connectionId, route.conversationId as ConversationId, {
      text,
    });
  }
}

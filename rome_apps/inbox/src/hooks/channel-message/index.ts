import { chatStopReceipt, createAppLogger, isStopCommand } from "@rome-os/app-runtime";
import type {
  ActionEngineLike,
  ChatStopHandler,
  ChannelMessageHook as ChannelMessageHookInterface,
  ConversationSettingsControl,
  InboundMessage,
  TalkRouter,
} from "@rome-os/app-runtime";

const log = createAppLogger("channel-message-hook");

export class ChannelMessageHook implements ChannelMessageHookInterface {
  private readonly subscriptions = new Map<string, () => void>();

  constructor(
    private readonly actionEngine: ActionEngineLike,
    private readonly talkRouter: TalkRouter,
    private readonly conversationSettings: ConversationSettingsControl,
    private readonly chatStop: ChatStopHandler,
  ) {}

  async register(): Promise<void> {
    for (const { connectionId, service } of await this.talkRouter.list()) {
      this.registerConnection(connectionId, service);
    }
  }

  registerConnection(connectionId: string, service: string): void {
    if (this.subscriptions.has(connectionId)) return;
    const unsubscribe = this.talkRouter.subscribe(connectionId, async (message) => {
      await this.handleMessage(connectionId, service, message);
    });
    this.subscriptions.set(connectionId, unsubscribe);
  }

  unregister(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
  }

  private async handleMessage(
    connectionId: string,
    service: string,
    message: InboundMessage,
  ): Promise<void> {
    if (!message.text?.trim() && message.attachments.length === 0) {
      log.debug("skipping empty message", { service, messageId: message.messageId });
      return;
    }

    const ref = { connectionId, conversationId: message.conversationId };
    if (isStopCommand(message.text)) {
      const addressing =
        message.addressing ?? (message.thread?.kind === "dm" ? "direct" : "ambient");
      if (addressing === "ambient") {
        log.debug("ignoring group stop command not directed at the bot", {
          service,
          messageId: message.messageId,
        });
        return;
      }
      try {
        const result = await this.chatStop({
          ref,
          service,
          senderId: message.senderId,
        });
        await this.talkRouter.send(connectionId, message.conversationId, {
          text: chatStopReceipt(result.status),
        });
      } catch (err) {
        log.error("stop command failed", {
          service,
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.talkRouter.send(connectionId, message.conversationId, {
          text: "Stop could not be requested. Please try again.",
        });
      }
      return;
    }

    let enabled = true;
    let routedAgentName: string | undefined;
    const snapshot = await this.conversationSettings.get(ref);
    enabled = snapshot.effective.enabled;
    routedAgentName = snapshot.effective.routing.agentName ?? undefined;
    if (!enabled) {
      log.debug("conversation disabled", { connectionId, conversationId: message.conversationId });
      return;
    }

    let attachments = message.attachments;
    const inboundMedia = this.talkRouter.feature(connectionId, "inboundMedia");
    if (inboundMedia && attachments.length > 0) {
      try {
        attachments = await inboundMedia.materialize(message);
      } catch (err) {
        log.error("failed to materialize incoming attachments", {
          service,
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const activity = Promise.resolve()
      .then(
        () =>
          this.talkRouter.feature(connectionId, "activity")?.begin({
            conversationId: message.conversationId,
            messageId: message.messageId,
          }) ?? null,
      )
      .then(async (session) => {
        await session?.update("thinking");
        return session;
      })
      .catch((err) => {
        log.warn("activity feedback failed", {
          service,
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    try {
      await this.actionEngine.run(
        "message_handler",
        {
          connectionId,
          channel: service,
          channelUserId: message.senderId,
          threadName: message.thread?.name,
          threadType: message.thread?.kind === "dm" ? "private" : "group",
          threadId: message.conversationId,
          parentThreadId: message.parentConversationId,
          displayName: message.senderDisplayName ?? message.senderId,
          text: message.text,
          timestamp: message.timestamp.toISOString(),
          attachments,
          messageId: message.messageId,
          replyTo: message.replyTo,
          routedAgentName,
        },
        {
          initiator: `connection:${connectionId}`,
          channelContext: {
            connectionId,
            channel: service,
            threadId: message.conversationId,
            parentThreadId: message.parentConversationId,
            channelUserId: message.senderId,
            threadName: message.thread?.name,
            threadType: message.thread?.kind === "dm" ? "private" : "group",
          },
        },
      );
      void activity
        .then((session) => session?.finish("done"))
        .catch((err) =>
          log.warn("activity cleanup failed", {
            service,
            messageId: message.messageId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    } catch (err) {
      void activity.then((session) => session?.finish("error")).catch(() => {});
      log.error("message_handler action failed", {
        service,
        messageId: message.messageId,
        senderId: message.senderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function createHook(deps: {
  actionEngine: ActionEngineLike;
  talkRouter: TalkRouter;
  conversationSettings: ConversationSettingsControl;
  chatStop: ChatStopHandler;
}): ChannelMessageHookInterface {
  return new ChannelMessageHook(
    deps.actionEngine,
    deps.talkRouter,
    deps.conversationSettings,
    deps.chatStop,
  );
}

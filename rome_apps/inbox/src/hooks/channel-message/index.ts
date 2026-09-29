import { chatStopReceipt, createAppLogger, isStopCommand } from "@rome-os/app-runtime";
import type {
  ActionEngineLike,
  Channel,
  ChatStopHandler,
  ChannelMessageHook as ChannelMessageHookInterface,
  ConversationSettingsControl,
  InboundEvent,
  TalkRouter,
} from "@rome-os/app-runtime";

const log = createAppLogger("channel-message-hook");

/**
 * How long the hook waits on one message before it stops holding that
 * conversation. The channel hears a conversation's next message only once the
 * hook settles the current one (rule R4 of `ChannelInbound`), so a turn that
 * never returned would silence the chat. Past this bound the hook stops
 * waiting and logs it; the turn itself keeps running, and the agent session
 * still queues the conversation's turns in arrival order.
 */
export const MESSAGE_SETTLE_MS = 15 * 60_000;

export class ChannelMessageHook implements ChannelMessageHookInterface {
  private readonly subscriptions: Array<() => void> = [];

  constructor(
    private readonly actionEngine: ActionEngineLike,
    private readonly talkRouter: TalkRouter,
    private readonly conversationSettings: ConversationSettingsControl,
    private readonly chatStop: ChatStopHandler,
    private readonly channels: readonly Channel[],
    private readonly options: { settleMs?: number } = {},
  ) {}

  /** Subscribe once to every channel that can receive. A channel's
   *  subscription follows whatever backs it, so a Connection that appears or
   *  reconnects later needs nothing more from the hook. */
  async register(): Promise<void> {
    if (this.subscriptions.length > 0) return;
    for (const channel of this.channels) {
      const inbound = channel.inbound;
      if (!inbound) continue;
      this.subscriptions.push(inbound.subscribe((event) => this.settle(channel, event)));
    }
  }

  /** Nothing to do: `register` already reaches every Connection's channel. */
  registerConnection(): void {}

  /** Detach from every channel. Messages still waiting are dropped by the
   *  channel; a turn already running finishes, and the agent session queues
   *  the successor hook's turns for that conversation behind it. */
  unregister(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
  }

  /** Handle one message, releasing its conversation within the settle bound. */
  private async settle(channel: Channel, event: InboundEvent): Promise<void> {
    const settleMs = this.options.settleMs ?? MESSAGE_SETTLE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("message still handling; releasing its conversation", {
          service: channel.name,
          messageId: event.message.messageId,
          settleMs,
        });
        resolve();
      }, settleMs);
    });
    try {
      await Promise.race([this.handleMessage(channel, event), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleMessage(channel: Channel, event: InboundEvent): Promise<void> {
    const { message, ref } = event;
    const { connectionId } = ref;
    const service = channel.name;
    if (!message.text?.trim() && message.attachments.length === 0) {
      log.debug("skipping empty message", { service, messageId: message.messageId });
      return;
    }

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
        await channel.send?.send(message.conversationId, {
          text: chatStopReceipt(result.status),
        });
      } catch (err) {
        log.error("stop command failed", {
          service,
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        await channel.send?.send(message.conversationId, {
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
    const inboundMedia = channel.inbound?.media ?? null;
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
  channels: readonly Channel[];
}): ChannelMessageHookInterface {
  return new ChannelMessageHook(
    deps.actionEngine,
    deps.talkRouter,
    deps.conversationSettings,
    deps.chatStop,
    deps.channels,
  );
}

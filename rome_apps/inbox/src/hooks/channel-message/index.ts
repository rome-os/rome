import { chatStopReceipt, createAppLogger, isStopCommand } from "@rome-os/app-runtime";
import type {
  ActionEngineLike,
  Channel,
  ChatStopHandler,
  ChannelMessageHook as ChannelMessageHookInterface,
  ChannelMessageHookDeps,
  ConversationId,
  ConversationSettingsControl,
  InboundEvent,
  ChannelActivitySession,
} from "@rome-os/app-runtime";

const log = createAppLogger("channel-message-hook");

/** Core's `AGENTS_SERVICE`, which an app cannot import. */
const AGENTS_CHANNEL = "agents";

/**
 * How long a turn may run before the hook reports it as still running: the
 * same ten minutes a channel waits before reporting a stuck handler (R4). The
 * hook dispatches turns without waiting on them, so the channel no longer sees
 * a turn that hangs; this keeps a silent chat visible. The turn is not stopped.
 */
export const SLOW_TURN_MS = 10 * 60_000;

export class ChannelMessageHook implements ChannelMessageHookInterface {
  /** Unsubscribe functions by channel name, one per channel this hook holds. */
  private readonly subscriptions = new Map<string, () => void>();

  constructor(
    private readonly actionEngine: ActionEngineLike,
    private readonly conversationSettings: ConversationSettingsControl,
    private readonly chatStop: ChatStopHandler,
    private readonly channels: readonly Channel[],
    private readonly options: {
      slowTurnMs?: number;
      log?: Pick<typeof log, "warn">;
      linkedAgentOf?: ChannelMessageHookDeps["linkedAgentOf"];
    } = {},
  ) {}

  /** Subscribe to every channel that can receive. A channel's subscription
   *  follows whatever backs it, so a Connection that appears or reconnects
   *  later needs nothing more from the hook. */
  async register(): Promise<void> {
    this.subscribe(this.channels);
  }

  /** Subscribe to channels the host added after `register`, such as a second
   *  bot whose Talk first unlocked. */
  async addChannels(channels: readonly Channel[]): Promise<void> {
    this.subscribe(channels);
  }

  /** Subscribe to each channel that can receive and that this hook does not
   *  hold yet, so no channel is ever subscribed twice. */
  private subscribe(channels: readonly Channel[]): void {
    for (const channel of channels) {
      const inbound = channel.inbound;
      if (!inbound || this.subscriptions.has(channel.name)) continue;
      this.subscriptions.set(
        channel.name,
        inbound.subscribe((event) => this.handleMessage(channel, event)),
      );
    }
  }

  /** Detach from every channel. Messages still waiting are dropped by the
   *  channel; a turn already running finishes, and the agent session queues
   *  the successor hook's turns for that conversation behind it. */
  unregister(): void {
    const unsubscribes = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const unsubscribe of unsubscribes) unsubscribe();
  }

  /**
   * Take one message through the checks that decide whether it becomes a turn,
   * then dispatch the turn and settle. The channel holds this conversation
   * until the handler settles (rule R4 of `ChannelInbound`), so waiting for
   * the whole turn would hold a `/stop` in the same chat behind the turn it is
   * meant to stop. Once dispatched, the order is best-effort: `message_handler`
   * awaits a person lookup, a policy check and a store before its turn reaches
   * the agent session's queue, so two quick messages can reach the session in
   * either order, as they could before the channel ordered its handlers.
   */
  private async handleMessage(channel: Channel, event: InboundEvent): Promise<void> {
    const { message, ref } = event;
    const { connectionId } = ref;
    const service = channel.name;
    if (!message.text?.trim() && message.attachments.length === 0) {
      log.debug("skipping empty message", { service, messageId: message.messageId });
      return;
    }

    // A program sends on `agents`, not a person, so `/stop` there is text for
    // the model, and `message_handler` decides whether Rome answers it.
    if (service !== AGENTS_CHANNEL && isStopCommand(message.text)) {
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
        await this.reply(channel, message.conversationId, chatStopReceipt(result.status));
      } catch (err) {
        log.error("stop command failed", {
          service,
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.reply(
          channel,
          message.conversationId,
          "Stop could not be requested. Please try again.",
        );
      }
      return;
    }

    // Read per message, since a relink changes it on the same channel. `/stop`
    // above still reaches a turn that started before an unlink.
    const linkedAgent = this.options.linkedAgentOf?.(service);
    if (linkedAgent === null) {
      log.debug("account has no linked agent; not answering", {
        service,
        messageId: message.messageId,
      });
      return;
    }

    const snapshot = await this.conversationSettings.get(ref);
    const enabled = snapshot.effective.enabled;
    // A group's own agent choice, which wins over the account's linked agent.
    // An explicit pin to main is stored as null, apart from no choice at all.
    const routedAgentName =
      snapshot.overrides.routing?.agentName === null
        ? "core:main"
        : (snapshot.effective.routing.agentName ?? undefined);
    if (!enabled) {
      log.debug("conversation disabled", { connectionId, conversationId: message.conversationId });
      return;
    }

    let attachments = message.attachments;
    // Through the channel's Connection, which is `ref`'s.
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
          // Typing follows the channel's current Connection, the one a reply would go out on.
          channel.send?.activity?.begin({
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
    void this.runTurn(message, service, connectionId, attachments, activity, {
      routedAgentName,
      linkedAgentName: linkedAgent,
    });
  }

  private async runTurn(
    message: InboundEvent["message"],
    service: string,
    connectionId: string,
    attachments: InboundEvent["message"]["attachments"],
    activity: Promise<ChannelActivitySession | null>,
    agents: { routedAgentName: string | undefined; linkedAgentName: string | undefined },
  ): Promise<void> {
    const slowTurnMs = this.options.slowTurnMs ?? SLOW_TURN_MS;
    const slow = setTimeout(() => {
      (this.options.log ?? log).warn("message turn still running", {
        service,
        messageId: message.messageId,
        runningMs: slowTurnMs,
      });
    }, slowTurnMs);
    slow.unref?.();
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
          ...agents,
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
    } finally {
      clearTimeout(slow);
    }
  }

  /** Answer in a conversation on the channel it arrived on, where it can send.
   *  The channel sends through the Connection backing it, which is `ref`'s. */
  private async reply(
    channel: Channel,
    conversationId: ConversationId,
    text: string,
  ): Promise<void> {
    if (!channel.send) {
      log.warn("cannot answer on a channel that does not send", { service: channel.name });
      return;
    }
    await channel.send.send(conversationId, { text });
  }
}

/** A host handed the hook no `channels`, so it would hear nothing. */
export class MissingChannelsError extends Error {
  constructor() {
    super(
      "The channel-message hook needs `channels` in its deps; this host passes none, so inbound messages would go unheard.",
    );
    this.name = "MissingChannelsError";
  }
}

/** Build the hook. Fails with {@link MissingChannelsError} on a host that
 *  passes no `channels`; the host keeps booting and reports the hook failed. */
export function createHook(deps: ChannelMessageHookDeps): ChannelMessageHookInterface {
  if (!Array.isArray(deps.channels)) throw new MissingChannelsError();
  return new ChannelMessageHook(
    deps.actionEngine,
    deps.conversationSettings,
    deps.chatStop,
    deps.channels,
    { linkedAgentOf: deps.linkedAgentOf },
  );
}

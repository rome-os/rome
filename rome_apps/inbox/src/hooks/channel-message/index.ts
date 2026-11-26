import {
  chatStopReceipt,
  createAppLogger,
  isSendRefused,
  isStopCommand,
} from "@rome-os/app-runtime";
import type {
  ActionEngineLike,
  Channel,
  ChatStopHandler,
  ChannelMessageHook as ChannelMessageHookInterface,
  ChannelMessageHookDeps,
  ChatSettingsControl,
  InboundEvent,
  ChannelActivitySession,
  SaidInboundEvent,
  MessagesSaid,
} from "@rome-os/app-runtime";

import type { WakeGateFor } from "../../actions/message-handler/index.js";

const log = createAppLogger("channel-message-hook");

/** Core's `AGENTS_KIND`, which an app cannot import. */
const AGENTS_CHANNEL = "agents";

/** The key of the one subscription a hook hearing recorded messages holds. No
 *  channel name starts with a NUL. */
const RECORDED = "\0recorded";

/**
 * How long a turn may run before the hook reports it as still running: the
 * same ten minutes a channel waits before reporting a stuck handler (R4). The
 * hook dispatches turns without waiting on them, so the channel no longer sees
 * a turn that hangs; this keeps a silent chat visible. The turn is not stopped.
 */
export const SLOW_TURN_MS = 10 * 60_000;

export class ChannelMessageHook implements ChannelMessageHookInterface {
  /** Unsubscribe functions by channel name, one per channel this hook holds.
   *  Hearing recorded messages, the one subscription is under `RECORDED`. */
  private readonly subscriptions = new Map<string, () => void>();
  /** The channels a recorded message may name, by name. */
  private readonly known = new Map<string, Channel>();

  constructor(
    private readonly actionEngine: ActionEngineLike,
    private readonly chatSettings: ChatSettingsControl,
    private readonly chatStop: ChatStopHandler,
    private readonly channels: readonly Channel[],
    private readonly options: {
      slowTurnMs?: number;
      log?: Pick<typeof log, "warn">;
      accountAgentOf?: ChannelMessageHookDeps["accountAgentOf"];
      unsafeTestOnlyBypassesInbox?: ChannelMessageHookDeps["unsafeTestOnlyBypassesInbox"];
      messagesSaid?: MessagesSaid;
      wakeGateFor?: WakeGateFor;
    } = {},
  ) {}

  /** Hear every message the host records, or, on a host that records none,
   *  subscribe to every channel that can receive. A channel's subscription
   *  follows whatever backs it, so a Connection that appears or reconnects
   *  later needs nothing more from the hook. */
  async register(): Promise<void> {
    const messagesSaid = this.options.messagesSaid;
    if (!messagesSaid) {
      this.subscribe(this.channels);
      return;
    }
    for (const channel of this.channels) this.known.set(channel.name, channel);
    if (this.subscriptions.has(RECORDED)) return;
    this.subscriptions.set(
      RECORDED,
      messagesSaid.subscribe((event) => this.handleRecorded(event)),
    );
  }

  /** Take in channels the host added after `register`, such as a second bot
   *  whose Talk first unlocked. */
  async addChannels(channels: readonly Channel[]): Promise<void> {
    if (!this.options.messagesSaid) {
      this.subscribe(channels);
      return;
    }
    for (const channel of channels) this.known.set(channel.name, channel);
  }

  /** Subscribe to each channel that can receive and that this hook does not
   *  hold yet, so no channel is ever subscribed twice. */
  private subscribe(channels: readonly Channel[]): void {
    for (const channel of channels) {
      const inbound = channel.inbound;
      if (!inbound || this.subscriptions.has(channel.name)) continue;
      this.subscriptions.set(
        channel.name,
        inbound.subscribe(async (event) => {
          await this.handleMessage(channel, event);
        }),
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

  /** Handle a recorded message, and say its wake is decided once no turn
   *  will come of it, or once the turn it started has ended. */
  private async handleRecorded(event: SaidInboundEvent): Promise<void> {
    const decided = () =>
      this.options.messagesSaid?.decided(event.recorded).catch((err) =>
        (this.options.log ?? log).warn("could not mark a message's wake decided", {
          messageId: event.message.messageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    const channel = this.known.get(event.message.channel);
    if (!channel) {
      (this.options.log ?? log).warn("recorded message names no channel the hook knows", {
        service: event.message.channel,
        messageId: event.message.messageId,
      });
      await decided();
      return;
    }
    let dispatched: { turn: Promise<void> } | undefined;
    try {
      dispatched = await this.handleMessage(channel, event);
    } finally {
      // The turn settles without throwing, and the chat's next message must
      // not wait on it.
      if (dispatched) void dispatched.turn.then(decided);
      else await decided();
    }
  }

  /**
   * Take one message through the checks that decide whether it becomes a turn,
   * then dispatch the turn and settle. The channel holds this conversation
   * until the handler settles (rule R4 of `ChannelInbound`), so waiting for
   * the whole turn would hold a `/stop` in the same chat behind the turn it is
   * meant to stop. Once dispatched, the order is best-effort: `inbox:message_handler`
   * awaits a person lookup, a policy check and a store before its turn reaches
   * the agent session's queue, so two quick messages can reach the session in
   * either order, as they could before the channel ordered its handlers.
   * Answers the dispatched turn, which never rejects, or nothing when no turn
   * comes of the message.
   */
  private async handleMessage(
    channel: Channel,
    event: InboundEvent | SaidInboundEvent,
  ): Promise<{ turn: Promise<void> } | undefined> {
    const { message, ref } = event;
    const recorded = "recorded" in event ? event.recorded : undefined;
    const { connectionId } = ref;
    const service = channel.name;
    if (!message.text?.trim() && message.attachments.length === 0) {
      log.debug("skipping empty message", { service, messageId: message.messageId });
      return;
    }

    // A program sends on `agents`, not a person, so `/stop` there is text for
    // the model, and `inbox:message_handler` decides whether Rome answers it.
    if (service !== AGENTS_CHANNEL && isStopCommand(message.text)) {
      const addressing =
        message.addressing ?? (message.thread?.kind === "dm" ? "direct" : "ambient");
      // Another bot cannot stop a turn, however the chat takes bots.
      if (addressing === "ambient" || message.fromBot) {
        log.debug("ignoring stop command not directed at the bot by a person", {
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
        await this.reply(channel, message, chatStopReceipt(result.status));
      } catch (err) {
        log.error("stop command failed", {
          service,
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.reply(channel, message, "Stop could not be requested. Please try again.");
      }
      return;
    }

    // Read per message, since switching the agent changes it on the same
    // account. `/stop` above still reaches a turn that started before an
    // unlink. A host that predates accounts names none, and answers the channel.
    const accountAgent = this.options.accountAgentOf?.(message.account ?? service);
    if (accountAgent === null) {
      log.debug("account has no agent; not answering", {
        service,
        messageId: message.messageId,
      });
      return;
    }
    // The agent's own app runs its turns (`deprecatedRunsOwnTurns`, ZHA-231).
    if (accountAgent && this.options.unsafeTestOnlyBypassesInbox?.(accountAgent)) {
      log.debug("account's agent runs its own turns; not answering", {
        service,
        agent: accountAgent,
        messageId: message.messageId,
      });
      return;
    }

    const snapshot = await this.chatSettings.get(ref);
    const enabled = snapshot.effective.enabled;
    // A group's own agent choice, which wins over the account's agent.
    // An explicit pin to main is stored as null, apart from no choice at all.
    const routedAgentName =
      snapshot.overrides.routing?.agentName === null
        ? "core:main"
        : (snapshot.effective.routing.agentName ?? undefined);
    // A recorded message carries People's answer for its sender, so the wake
    // gate decides here, before typing shows. Without
    // it, `inbox:message_handler` asks the gate once it has looked the sender up.
    const sender = "sender" in event ? event.sender : undefined;
    let wake: "wake" | undefined;
    if (sender && this.options.wakeGateFor) {
      const gate = await this.options.wakeGateFor({ chat: ref });
      const decision = gate(
        {
          connectionId,
          chatId: message.chatId,
          channel: service,
          place: message.thread?.kind === "dm" ? "direct" : "group",
          threadName: message.thread?.name,
          ...addressedBy(message),
        },
        {
          person: sender.person
            ? { id: sender.person.id, bondLevel: sender.person.bondLevel }
            : null,
        },
      );
      // Logged at info, since no action span is open here to carry the
      // policy decision as an event.
      log.info("wake decided", {
        connectionId,
        chatId: message.chatId,
        messageId: message.messageId,
        bondLevel: sender.person?.bondLevel ?? "other",
        decision,
      });
      if (decision !== "wake") return;
      wake = decision;
    } else if (!enabled) {
      log.debug("conversation disabled", { connectionId, chatId: message.chatId });
      return;
    }

    let attachments = message.attachments;
    // Through the channel's Connection, which is `ref`'s. A recorded message's
    // attachments were saved before it was recorded.
    const inboundMedia = recorded ? null : (channel.inbound?.media ?? null);
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
            chatId: message.chatId,
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
    const turn = this.runTurn(message, service, connectionId, attachments, activity, {
      routedAgentName,
      accountAgentName: accountAgent,
      ...(recorded ? { recordedMessageId: recorded.messageId } : {}),
      ...(wake ? { wake } : {}),
    });
    return { turn };
  }

  private async runTurn(
    message: InboundEvent["message"],
    service: string,
    connectionId: string,
    attachments: InboundEvent["message"]["attachments"],
    activity: Promise<ChannelActivitySession | null>,
    agents: {
      routedAgentName: string | undefined;
      accountAgentName: string | undefined;
      recordedMessageId?: string;
      wake?: "wake";
    },
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
        "inbox:message_handler",
        {
          connectionId,
          channel: service,
          channelUserId: message.senderId,
          threadName: message.thread?.name,
          threadType: message.thread?.kind === "dm" ? "private" : "group",
          threadId: message.chatId,
          parentThreadId: message.parentChatId,
          displayName: message.senderDisplayName ?? message.senderId,
          text: message.text,
          timestamp: message.timestamp.toISOString(),
          attachments,
          messageId: message.messageId,
          replyTo: message.replyTo,
          ...(message.inThread ? { inThread: message.inThread } : {}),
          ...addressedBy(message),
          ...agents,
        },
        {
          initiator: `connection:${connectionId}`,
          // A burst from more chats than there are workers waits for one
          // rather than dropping the message. The hook holds no worker.
          whenWorkersBusy: "queue",
          channelContext: {
            connectionId,
            channel: service,
            threadId: message.chatId,
            parentThreadId: message.parentChatId,
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
      log.error("inbox:message_handler action failed", {
        service,
        messageId: message.messageId,
        senderId: message.senderId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(slow);
    }
  }

  /** Answers `message` in its chat on the channel it arrived on, where it can
   *  send. The channel sends through the Connection backing it, which is
   *  `ref`'s. Outside a direct message the answer replies to `message`, so it
   *  stays in the message's thread, unless the platform cannot quote. */
  private async reply(
    channel: Channel,
    message: InboundEvent["message"],
    text: string,
  ): Promise<void> {
    if (!channel.send) {
      log.warn("cannot answer on a channel that does not send", { service: channel.name });
      return;
    }
    if (message.thread?.kind === "dm") {
      await channel.send.send(message.chatId, { text });
      return;
    }
    try {
      await channel.send.send(message.chatId, { text, replyToMessageId: message.messageId });
    } catch (err) {
      // Where the platform cannot quote, the answer goes again in place.
      if (!isSendRefused(err) || err.reason !== "reply_unaddressable") throw err;
      await channel.send.send(message.chatId, { text });
    }
  }
}

/** A host that passes only `linkedAgentOf` predates accounts, so its messages
 *  name none and the hook asks it by channel name alone. */
function byChannelName(
  linkedAgentOf: ChannelMessageHookDeps["linkedAgentOf"],
): ChannelMessageHookDeps["accountAgentOf"] {
  if (!linkedAgentOf) return undefined;
  return (target) => (typeof target === "string" ? linkedAgentOf(target) : undefined);
}

/** Core's wake gate, passed beside the hook deps the SDK describes. A host
 *  that predates it passes none. */
function wakeGateForOf(deps: ChannelMessageHookDeps): WakeGateFor | undefined {
  const candidate = (deps as { wakeGateFor?: unknown }).wakeGateFor;
  return typeof candidate === "function" ? (candidate as WakeGateFor) : undefined;
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
    deps.chatSettings ?? deps.conversationSettings,
    deps.chatStop,
    deps.channels,
    {
      accountAgentOf: deps.accountAgentOf ?? byChannelName(deps.linkedAgentOf),
      ...(deps.unsafeTestOnlyBypassesInbox
        ? { unsafeTestOnlyBypassesInbox: deps.unsafeTestOnlyBypassesInbox }
        : {}),
      ...(deps.messagesSaid ? { messagesSaid: deps.messagesSaid } : {}),
      ...(wakeGateForOf(deps) ? { wakeGateFor: wakeGateForOf(deps) } : {}),
    },
  );
}

/** How the message addressed Rome's account, as its connection reported it. */
function addressedBy(
  message: InboundEvent["message"],
): Pick<InboundEvent["message"], "addressing" | "fromBot" | "mentionsOthers"> {
  return {
    ...(message.addressing ? { addressing: message.addressing } : {}),
    ...(message.fromBot ? { fromBot: true } : {}),
    ...(message.mentionsOthers ? { mentionsOthers: true } : {}),
  };
}

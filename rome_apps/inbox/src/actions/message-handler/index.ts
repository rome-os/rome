import { createAppLogger, getCurrentActionContext, isCoreMainAgentId } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AgentRunnerInterface,
  AppActionRuntimeDeps,
  ApprovalsRepository,
  Attachment,
  BondLevel,
  ChatId,
  ChatRecord,
  ChatRef,
  ChatRepository,
  EnsureChannelChatInput,
  MessageAddressing,
  MessageReplyReference,
  PersonMappingRepository,
  PersonRecord,
  StreamAgentMessage,
} from "@rome-os/app-runtime";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const log = createAppLogger("message-handler");

// ---------------------------------------------------------------------------
// Dependencies injected via factory
// ---------------------------------------------------------------------------

/** Core's send gate, which the SDK does not describe yet. */
export type SendGate = (request: {
  destination: {
    connectionId: string;
    chatId: string;
    place: "direct" | "group";
    sameChatAsWake: boolean;
    onlyGuardianReads: boolean;
  };
  recipient: { bondLevel: BondLevel } | null;
  author: { agentName: string };
}) => "send" | "check" | "ask_guardian" | "refuse";

/** Core's wake gate, which the SDK does not describe yet. */
export type WakeGate = (
  message: {
    connectionId: string;
    chatId: string;
    channel: string;
    place: "direct" | "group";
    threadName?: string;
    addressing?: MessageAddressing;
    fromBot?: boolean;
    mentionsOthers?: boolean;
  },
  sender: { person: { id: string; bondLevel: BondLevel } | null },
) => "wake" | "quiet" | "block";

/** The wake gate for a chat, built from its current settings. */
export type WakeGateFor = (request: { chat: ChatRef }) => Promise<WakeGate>;

export interface MessageHandlerDeps {
  agentRunner: AgentRunnerInterface;
  sendGate: SendGate;
  personMappingRepo: PersonMappingRepository;
  approvalsRepo: ApprovalsRepository;
  wakeGateFor: WakeGateFor;
  emitAgentMessage?: (message: StreamAgentMessage) => void;
  resolveProfilePath(filePath: string): string;
  strangerPersonId: string;
}

type MessageHandlerRuntimeDeps = AppActionRuntimeDeps<MessageHandlerDeps>;

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

interface MessageContext {
  channel: string;
  threadId: string;
  channelUserId: string;
  displayName: string;
  bondLevel: string;
  selectedProjectName?: string;
  selectedProjectPath?: string;
  threadName?: string;
  threadType?: string;
  person: PersonRecord | null;
}

type CollectedAgentResult =
  | { success: true; content: string; structuredOutput?: unknown; turnId?: string }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function readMarkdownContext(filePath: string): string | null {
  const fullPath = isAbsolute(filePath) ? filePath : filePath;
  if (!existsSync(fullPath)) return null;

  try {
    const content = readFileSync(fullPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function isAttachment(value: unknown): value is Attachment {
  return typeof value === "object" && value !== null && "type" in value;
}

export function appendAttachmentPathsToPrompt(text: string, attachments: unknown): string {
  const savedAttachments = Array.isArray(attachments)
    ? attachments.filter(
        (attachment): attachment is Attachment =>
          isAttachment(attachment) &&
          typeof attachment.localPath === "string" &&
          attachment.localPath.trim().length > 0,
      )
    : [];

  if (savedAttachments.length === 0) return text.trim();

  const lines = savedAttachments.map((attachment, index) => {
    const name = attachment.fileName ? ` ${attachment.fileName}` : "";
    const caption = attachment.caption ? ` caption: ${attachment.caption}` : "";
    return `Attachment ${index + 1} (${attachment.type}${name}) path: ${attachment.localPath}${caption}`;
  });

  return [text.trim(), lines.join("\n")].filter(Boolean).join("\n\n").trim();
}

function parseMessageReplyReference(value: unknown): MessageReplyReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.messageId !== "string" || !candidate.messageId.trim()) return undefined;
  return {
    messageId: candidate.messageId.trim(),
    ...(typeof candidate.content === "string" && candidate.content
      ? { content: candidate.content }
      : {}),
    ...(typeof candidate.senderName === "string" && candidate.senderName.trim()
      ? { senderName: candidate.senderName.trim() }
      : {}),
  };
}

function getRuntimeThreadPath(): string | undefined {
  const threadPath = getCurrentActionContext()?.channelContext?.threadPath;
  return typeof threadPath === "string" && threadPath.trim() ? threadPath : undefined;
}

export function buildMessageContext(
  ctx: MessageContext & {
    resolveProfilePath(filePath: string): string;
    strangerPersonId: string;
  },
): string {
  const readContext = (filePath: string) => {
    const resolved = isAbsolute(filePath) ? filePath : ctx.resolveProfilePath(filePath);
    return readMarkdownContext(resolved);
  };

  // Only the STABLE Guardian profile belongs in this system-prompt suffix, so
  // it stays in the cacheable system prefix. Who sent each message reaches the
  // agent on the message itself, not here: a group has many senders, and the
  // suffix is fixed when the session opens. The per-thread, dynamic thread +
  // project framing is rendered separately as a `<thread_context>` block on the session's FIRST user message
  // (one renderer for every channel) — see `buildThreadContextBlock` in
  // @rome/core agent/domain/prompt.ts and AgentSession.runOneTurn. The thread context
  // travels there via the `threadContext` already forwarded into the agent run.
  return [
    "# Context",
    "",
    "## Guardian",
    "",
    readContext("memory/relationship/GUARDIAN.md") ?? "Guardian profile unavailable.",
  ].join("\n");
}

/** Who the envoy is told a reply goes to: the answered message's sender. */
export interface EnvoyRecipient {
  /** The name the message showed, which the sender chose. */
  shownName: string;
  /** The person Rome links to the sender's account, or null when none. */
  person: string | null;
  bondLevel: string;
  threadType?: string;
}

const BOND_LEVEL_WORDS: Record<string, string> = {
  guardian: "guardian",
  "inner-circle": "inner circle",
  acquaintance: "acquaintance",
  other: "other",
};

/** The sender as the replying agent reads them, `Ada [Ada Lovelace, inner circle]`,
 *  the same form Rome labels each message the agent reads with (`whoSaid` in
 *  packages/core/src/chats/sender-labels.ts, which apps cannot import). */
export function recipientLabel(recipient: EnvoyRecipient): string {
  const who = recipient.person
    ? `${recipient.person}, ${BOND_LEVEL_WORDS[recipient.bondLevel] ?? recipient.bondLevel}`
    : "not linked";
  return `${recipient.shownName} [${who}]`;
}

function placeOf(threadType: string | undefined): string {
  if (threadType === "private") return "direct message";
  if (threadType === "group") return "group chat";
  return "chat";
}

async function envoyCheck(
  runner: AgentRunnerInterface,
  outgoingText: string,
  originalMessage: string,
  recipient: EnvoyRecipient,
  replyingAgent: string,
  workingDir?: string,
): Promise<{ action: "approve" | "reject" | "require_approval"; reason?: string }> {
  const place = placeOf(recipient.threadType);
  const prompt = [
    `Validate this outgoing message before it is sent.`,
    ``,
    `Message being answered, from ${recipientLabel(recipient)}:`,
    originalMessage,
    ``,
    `The reply goes to that sender, in the same ${place} the message was sent in.`,
    `The sender is not the guardian: the guardian's replies skip this check.`,
    `Replying agent: ${replyingAgent}`,
    ``,
    `Proposed reply:`,
    outgoingText,
  ].join("\n");

  const envoyResult = await collectAgentResult(
    runner,
    {
      agentName: "envoy",
      prompt,
      workingDir,
    },
    undefined,
    "envoy",
  );

  if (!envoyResult.success) {
    log.warn("envoy validation failed; requiring approval", { error: envoyResult.error });
    return {
      action: "require_approval",
      reason: `Envoy validation failed: ${envoyResult.error}`,
    };
  }

  return readEnvoyVerdict(envoyResult.structuredOutput, envoyResult.content);
}

const ENVOY_VERDICTS = ["approve", "require_approval", "reject"] as const;
type EnvoyVerdict = (typeof ENVOY_VERDICTS)[number];

/**
 * The envoy's decision is its `verdict` field and nothing else. An answer
 * without a known verdict holds the message for the guardian.
 */
function readEnvoyVerdict(
  structuredOutput: unknown,
  content: string,
): { action: EnvoyVerdict; reason?: string } {
  const answer =
    structuredOutput && typeof structuredOutput === "object"
      ? (structuredOutput as { verdict?: unknown; reason?: unknown })
      : undefined;
  const verdict = ENVOY_VERDICTS.find((v) => v === answer?.verdict);
  if (!verdict) {
    log.warn("envoy answered without a verdict; requiring approval", { content });
    return {
      action: "require_approval",
      reason: `Envoy answered without a verdict: ${content}`,
    };
  }
  const reason = typeof answer?.reason === "string" ? answer.reason : undefined;
  return { action: verdict, ...(reason ? { reason } : {}) };
}

async function collectAgentResult(
  runner: AgentRunnerInterface,
  params: Parameters<AgentRunnerInterface["run"]>[0],
  emitAgentMessage?: (message: StreamAgentMessage) => void,
  agentName?: string,
): Promise<CollectedAgentResult> {
  let response = "";
  let structuredOutput: unknown;
  let lastError = "";
  let turnId: string | undefined;
  for await (const msg of runner.run(params)) {
    if (msg.type === "turn_start") {
      turnId = msg.turnId;
    }
    if (msg.type === "result") {
      response = msg.content;
      structuredOutput = msg.structuredOutput;
    }
    if (msg.type === "error") lastError = msg.error;
    emitAgentMessage?.({ ...msg, agent: agentName });
  }
  if (!response && lastError) {
    log.warn("agent returned error instead of result", { agentName, error: lastError });
    return { success: false, error: lastError };
  }
  return { success: true, content: response, structuredOutput, turnId };
}

function requireChatRepository(deps: MessageHandlerRuntimeDeps): ChatRepository {
  const repository =
    deps.appContext.repositories.chats ?? deps.appContext.repositories.conversations;
  if (!repository) throw new Error("Chat repository is unavailable");
  return repository;
}

/** Opens the chat for a channel thread, or finds the one already open. A host
 *  that predates the chat names offers only `ensureChannelConversation`. */
function ensureChannelChat(
  repository: ChatRepository,
  input: EnsureChannelChatInput,
): Promise<ChatRecord> {
  return typeof repository.ensureChannelChat === "function"
    ? repository.ensureChannelChat(input)
    : repository.ensureChannelConversation(input);
}

/**
 * `requested` while it is loaded, or `fallback` when it is not. Main, in
 * either spelling, is always loaded and resolves to `main`. A failed check
 * honors `requested`.
 */
async function resolveAgent<F extends string | null>(
  deps: MessageHandlerRuntimeDeps,
  requested: string,
  fallback: F,
): Promise<string | F> {
  if (isCoreMainAgentId(requested)) return "main";
  try {
    if ((await deps.agentRunner.hasAgent?.(requested)) === false) {
      // Core already warns, once per channel, for an account's agent that is not
      // loaded, and falling back to main is routine after an app is removed.
      log.debug("agent is not loaded", { agent: requested, fallback });
      return fallback;
    }
  } catch (err) {
    log.warn("hasAgent check failed; honoring requested agent", {
      agent: requested,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return requested;
}

// ---------------------------------------------------------------------------
// The agent's turn: target agent -> envoy check -> send / approval gate
// ---------------------------------------------------------------------------

async function runTurnAndReply(
  deps: MessageHandlerRuntimeDeps,
  args: Record<string, unknown>,
  channelThreadKey: string,
  contextSuffix: string,
  chatId: string,
  targetAgent: string,
): Promise<ActionResult> {
  const { connectionId, channel, channelUserId, threadId, text, messageId } = args as Record<
    string,
    string
  >;
  const bondLevel = (args.bondLevel as string) ?? "guardian";
  const workingDir =
    typeof args.workingDir === "string" && args.workingDir.trim() ? args.workingDir : undefined;
  const threadPath = getRuntimeThreadPath();

  log.info("running agent", {
    channel,
    channelUserId,
    bondLevel,
    agent: targetAgent,
  });

  const mainResult = await collectAgentResult(
    deps.agentRunner,
    {
      agentName: targetAgent,
      prompt: text,
      channelThreadKey,
      romeSessionId: chatId,
      platformMessageId: messageId,
      replyTo: parseMessageReplyReference(args.replyTo),
      ...(typeof args.inThread === "string" && args.inThread
        ? { inThread: args.inThread as ChatId }
        : {}),
      threadContext: {
        connectionId,
        channel,
        threadId,
        parentThreadId: typeof args.parentThreadId === "string" ? args.parentThreadId : undefined,
        romeSessionId: chatId,
        threadPath,
        channelUserId,
        threadName: typeof args.threadName === "string" ? args.threadName : undefined,
        threadType:
          args.threadType === "private" || args.threadType === "group"
            ? args.threadType
            : undefined,
        projectName:
          typeof args.selectedProjectName === "string" ? args.selectedProjectName : undefined,
        // Carry the sender's bond level so the core login gate can scope the
        // guardian-only "no AI tool configured" notice to the guardian.
        senderBondLevel: bondLevel,
      },
      contextSuffix,
      workingDir,
    },
    deps.emitAgentMessage,
    targetAgent,
  );

  if (!mainResult.success) {
    return { status: "error", error: mainResult.error };
  }

  const response = mainResult.content;

  if (!response) {
    log.info("agent returned no response", { channel, channelUserId });
    return { status: "ok", data: { action: "no_response" } };
  }

  const approval = { type: "outgoing_message" as const, requestedBy: targetAgent };
  const payload = { response, channel, threadId, messageId, channelUserId };
  const send = () =>
    sendAnswer(deps, {
      channel,
      threadId,
      text: response,
      channelUserId,
      replyToMessageId: messageId,
      romeSessionId: chatId,
      ...(mainResult.turnId ? { turnId: mainResult.turnId } : {}),
      knownToProvider: true,
    });
  const senderPerson = typeof args.senderPerson === "string" ? args.senderPerson : null;
  const recipient =
    typeof args.senderPerson === "string" ? { bondLevel: bondLevel as BondLevel } : null;
  const place = args.threadType === "private" ? "direct" : "group";
  const decision = deps.sendGate({
    destination: {
      connectionId,
      chatId: threadId,
      place,
      // The reply goes to the chat the message came from.
      sameChatAsWake: true,
      onlyGuardianReads: place === "direct" && recipient?.bondLevel === "guardian",
    },
    recipient,
    author: { agentName: targetAgent },
  });
  log.info("send gate decision", { decision, channel, channelUserId });

  if (decision === "send") {
    await send();
    await deps.approvalsRepo.create({
      ...approval,
      description: "Skipped envoy (guardian)",
      payload,
      status: "auto_approved",
    });
    return { status: "ok", data: { action: "sent", response } };
  }
  if (decision === "ask_guardian") {
    await deps.approvalsRepo.create({
      ...approval,
      description: "Held by the send gate",
      payload,
    });
    return { status: "ok", data: { action: "pending_approval", response } };
  }
  if (decision === "refuse") {
    await deps.approvalsRepo.create({
      ...approval,
      description: "Refused by the send gate",
      payload,
      status: "rejected",
    });
    return { status: "ok", data: { action: "rejected_by_send_gate" } };
  }

  log.info("running envoy check", { channel, channelUserId });
  const envoyResult = await envoyCheck(
    deps.agentRunner,
    response,
    text,
    {
      shownName: typeof args.displayName === "string" ? args.displayName : channelUserId,
      person: senderPerson,
      bondLevel,
      threadType: typeof args.threadType === "string" ? args.threadType : undefined,
    },
    targetAgent,
    workingDir,
  );
  log.info("envoy decision", { action: envoyResult.action, channel, channelUserId });

  if (envoyResult.action === "approve") {
    await send();
    await deps.approvalsRepo.create({
      ...approval,
      description: envoyResult.reason ?? "Envoy approved",
      payload,
      status: "auto_approved",
    });
    return { status: "ok", data: { action: "sent", response } };
  }

  if (envoyResult.action === "require_approval") {
    await deps.approvalsRepo.create({
      ...approval,
      description: envoyResult.reason ?? "Envoy flagged for approval",
      payload,
    });
    return { status: "ok", data: { action: "pending_approval", response } };
  }

  await deps.approvalsRepo.create({
    ...approval,
    description: envoyResult.reason ?? "Envoy rejected",
    payload,
    status: "rejected",
  });
  return {
    status: "ok",
    data: { action: "rejected_by_envoy", reason: envoyResult.reason },
  };
}

// ---------------------------------------------------------------------------
// Factory: createMessageHandlerAction
// ---------------------------------------------------------------------------

export function createMessageHandlerAction(
  config: ActionConfig,
  deps: MessageHandlerRuntimeDeps,
): Action {
  return {
    config,
    // No inputSchema — not agent-callable
    async execute(args: Record<string, unknown>): Promise<ActionResult> {
      const {
        connectionId,
        channel,
        channelUserId,
        threadId,
        threadName,
        threadType,
        displayName,
        text,
      } = args as Record<string, string>;
      if (!connectionId) {
        return { status: "error", error: "Inbound message is missing its connection id" };
      }
      const selectedProjectName =
        typeof args.selectedProjectName === "string" ? args.selectedProjectName : undefined;
      const selectedProjectPath = typeof args.workingDir === "string" ? args.workingDir : undefined;

      const personOverride = args.personOverride as PersonRecord | undefined;

      try {
        log.info("message received", { channel, channelUserId, displayName });

        // An action queued before the rename carries `linkedAgentName`.
        const accountAgentName = args.accountAgentName ?? args.linkedAgentName;
        const accountAgent =
          typeof accountAgentName === "string" && accountAgentName.trim()
            ? accountAgentName.trim()
            : undefined;
        // The host passes no agent it knows is not loaded, so a null here
        // means the account's agent was unloaded since, and the account is silent.
        const answeringAgent = accountAgent
          ? await resolveAgent(deps, accountAgent, null)
          : undefined;
        if (answeringAgent === null) {
          return { status: "ok", data: { action: "silent" } };
        }

        // Only a link resolves a sender (docs/concepts/people.md#link). The
        // display name is whatever the sender typed, so an unlinked account
        // stays a stranger until the guardian links it, even when
        // its name matches the guardian's or a known person's.
        const person = (personOverride ??
          (await deps.personMappingRepo.findByChannelUser(
            channel,
            channelUserId,
          ))) as PersonRecord | null;

        const bondLevel = (person?.bondLevel as string) ?? "other";

        // The hook asked the wake gate already when the host recorded the
        // message with People's answer; otherwise ask it here.
        const wake =
          args.wake === "wake"
            ? args.wake
            : (await deps.wakeGateFor({ chat: { connectionId, chatId: threadId as ChatId } }))(
                {
                  connectionId,
                  chatId: threadId,
                  channel,
                  place: threadType === "private" ? "direct" : "group",
                  threadName,
                  ...addressedBy(args),
                },
                { person: person ? { id: person.id, bondLevel: person.bondLevel } : null },
              );

        if (wake === "block") {
          log.info("message blocked by policy", { channel, channelUserId });
          return { status: "ok", data: { action: "blocked" } };
        }

        const conversations = requireChatRepository(deps);
        const requestedAgent =
          typeof args.routedAgentName === "string" && args.routedAgentName.trim()
            ? args.routedAgentName.trim()
            : "main";
        const initialAgent = await resolveAgent(deps, requestedAgent, "main");
        const parentThreadId =
          typeof args.parentThreadId === "string" && args.parentThreadId
            ? args.parentThreadId
            : undefined;
        const conversation = await ensureChannelChat(conversations, {
          channel,
          threadId,
          parentThreadId,
          threadName,
          threadType: threadType === "private" || threadType === "group" ? threadType : undefined,
          agentName: initialAgent,
          projectName: selectedProjectName,
          projectPath: selectedProjectPath,
        });
        // Root conversations retain their persisted override, and native
        // thread sessions are refreshed from their parent's. A group's or
        // channel's override wins over the account's agent, which answers
        // private chats and the rest, and is never stored, so switching it
        // takes effect on the next message.
        const storedAgent =
          conversation.agentName && !isCoreMainAgentId(conversation.agentName)
            ? conversation.agentName
            : undefined;
        // The conversation row stores main as null, so only the hook's routing
        // tells a group pinned to main apart from one with no choice.
        const pinnedMain =
          typeof args.routedAgentName === "string" &&
          isCoreMainAgentId(args.routedAgentName.trim());
        const override =
          answeringAgent && threadType === "private"
            ? undefined
            : pinnedMain
              ? "main"
              : storedAgent;
        // An override whose app was removed falls back to the account's agent.
        const targetAgent = !override
          ? (answeringAgent ?? "main")
          : answeringAgent
            ? await resolveAgent(deps, override, answeringAgent)
            : override;
        const platformMessageId =
          typeof args.messageId === "string" && args.messageId
            ? args.messageId
            : (() => {
                throw new Error("Inbound channel message is missing its platform message id");
              })();
        const promptText = appendAttachmentPathsToPrompt(text ?? "", args.attachments);
        const messageContent = JSON.stringify([{ type: "text", content: promptText }]);
        const createdAt =
          typeof args.timestamp === "string" && !Number.isNaN(Date.parse(args.timestamp))
            ? new Date(args.timestamp)
            : undefined;
        const replyTo = parseMessageReplyReference(args.replyTo);
        const replyToPlatformMessageId = replyTo?.messageId;
        // The host recorded the message before this action ran, as said while
        // the agent was away. Waking the agent makes it the turn's prompt.
        const recorded =
          typeof args.recordedMessageId === "string" && args.recordedMessageId.length > 0;
        if (wake !== "wake") {
          const stored = recorded
            ? { inserted: true }
            : await conversations.addMessage({
                sessionId: conversation.id,
                role: "notification",
                content: messageContent,
                platformMessageId,
                senderId: channelUserId,
                senderName: displayName,
                replyToPlatformMessageId,
                createdAt,
              });
          if (!stored.inserted) {
            return { status: "ok", data: { action: "duplicate", messageId: platformMessageId } };
          }
          log.info("message wakes nobody", {
            channel,
            channelUserId,
            bondLevel,
          });
          return { status: "ok", data: { action: "ignored_by_reply_settings", bondLevel } };
        }

        const channelThreadKey = `${channel}:${threadId}`;
        const contextSuffix = buildMessageContext({
          channel,
          threadId,
          channelUserId,
          displayName,
          bondLevel,
          selectedProjectName,
          selectedProjectPath,
          threadName,
          threadType,
          person: person as PersonRecord | null,
          resolveProfilePath: deps.resolveProfilePath,
          strangerPersonId: deps.strangerPersonId,
        });

        const senderPerson =
          person && person.id !== deps.strangerPersonId ? person.displayName : null;
        const enrichedArgs = { ...args, text: promptText, bondLevel, replyTo, senderPerson };

        if (recorded) {
          await conversations.promoteMessageToUser(conversation.id, platformMessageId);
        }
        const stored = recorded
          ? { inserted: true }
          : await conversations.addMessage({
              sessionId: conversation.id,
              role: "user",
              content: messageContent,
              platformMessageId,
              senderId: channelUserId,
              senderName: displayName,
              replyToPlatformMessageId,
              createdAt,
            });
        if (!stored.inserted) {
          return { status: "ok", data: { action: "duplicate", messageId: platformMessageId } };
        }

        log.info("routing message", {
          channel,
          channelUserId,
          bondLevel,
          wake,
        });

        return runTurnAndReply(
          deps,
          enrichedArgs,
          channelThreadKey,
          contextSuffix,
          conversation.id,
          targetAgent,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error("message handler failed", { channel, channelUserId, error: errorMsg });
        return { status: "error", error: errorMsg };
      }
    },
  };
}

export function createAction(config: ActionConfig, deps: MessageHandlerRuntimeDeps): Action {
  return createMessageHandlerAction(config, deps);
}

/** Send an answer that quotes the message it answers. Where the platform
 *  cannot quote, the send is refused, and the answer goes again without the
 *  quote: the quote is the inbox's own choice, not the agent's words. */
export async function sendAnswer(
  deps: Pick<MessageHandlerRuntimeDeps, "appContext">,
  input: Record<string, unknown> & { replyToMessageId?: string },
): Promise<void> {
  try {
    await deps.appContext.runAction("system:send_message", input);
  } catch (err) {
    // Matched by its fields, not its class, as `isSendRefused` matches, so a
    // copy of the SDK other than the host's still recognizes it.
    const unquotable =
      err instanceof Error &&
      err.name === "ActionInvocationError" &&
      (err as { refusal?: unknown }).refusal === "reply_unaddressable";
    if (!unquotable || input.replyToMessageId === undefined) throw err;
    const { replyToMessageId: _quote, ...unquoted } = input;
    await deps.appContext.runAction("system:send_message", unquoted);
  }
}

/** How the message addressed Rome's account, as far as the hook passed it. */
function addressedBy(
  args: Record<string, unknown>,
): Pick<Parameters<WakeGate>[0], "addressing" | "fromBot" | "mentionsOthers"> {
  return {
    ...(typeof args.addressing === "string"
      ? { addressing: args.addressing as MessageAddressing }
      : {}),
    ...(args.fromBot === true ? { fromBot: true } : {}),
    ...(args.mentionsOthers === true ? { mentionsOthers: true } : {}),
  };
}

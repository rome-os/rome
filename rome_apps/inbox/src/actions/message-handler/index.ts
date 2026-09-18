import { createAppLogger, getCurrentActionContext } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AgentRunnerInterface,
  AppActionRuntimeDeps,
  ApprovalsRepository,
  Attachment,
  ConversationRepository,
  MessageReplyReference,
  PersonMappingRepository,
  PersonRecord,
  PolicyEngine,
  SentinelLogRepository,
  StreamAgentMessage,
} from "@rome-os/app-runtime";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const log = createAppLogger("message-handler");

// ---------------------------------------------------------------------------
// Dependencies injected via factory
// ---------------------------------------------------------------------------

export interface MessageHandlerDeps {
  agentRunner: AgentRunnerInterface;
  personMappingRepo: PersonMappingRepository;
  sentinelLogRepo: SentinelLogRepository;
  approvalsRepo: ApprovalsRepository;
  policyEngine: PolicyEngine;
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

export interface SentinelDecision {
  action: "replied" | "ignored" | "escalated";
  response?: string;
}

type CollectedAgentResult =
  | { success: true; content: string; turnId?: string }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

const DEFAULT_TRUSTED_BOND_LEVELS = ["guardian"];
const DEFAULT_REPLY_TO_BOND_LEVELS = ["guardian"];

function isTrustedBondLevel(bondLevel: string, trustedLevels: string[]): boolean {
  return trustedLevels.includes(bondLevel);
}

function canReplyToBondLevel(bondLevel: string, replyToLevels: string[]): boolean {
  return replyToLevels.includes(bondLevel);
}

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

function buildSenderInfo(
  ctx: MessageContext & {
    resolveProfilePath(filePath: string): string;
    strangerPersonId: string;
  },
): string {
  if (!ctx.person || ctx.person.id === ctx.strangerPersonId) {
    return "stranger (no person mapping yet)";
  }

  if (!ctx.person.profilePath) {
    return [
      `Mapped person: ${ctx.person.displayName}`,
      `Bond level: ${ctx.person.bondLevel}`,
      "Sender profile markdown unavailable.",
    ].join("\n");
  }

  return (
    readMarkdownContext(ctx.resolveProfilePath(ctx.person.profilePath)) ??
    [
      `Mapped person: ${ctx.person.displayName}`,
      `Bond level: ${ctx.person.bondLevel}`,
      `Sender profile missing: ${ctx.person.profilePath}`,
    ].join("\n")
  );
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

  // Only the STABLE Guardian profile (and, for non-guardian senders, the Sender
  // info) belongs in this system-prompt suffix — both stay in the cacheable
  // system prefix. The per-thread, dynamic thread + project framing is rendered
  // separately as a `<thread_context>` block on the session's FIRST user message
  // (one renderer for every channel) — see `buildThreadContextBlock` in
  // @rome/core prompt-builder.ts and AgentSession.runOneTurn. The thread context
  // travels there via the `threadContext` already forwarded into the agent run.
  const sections: string[] = [
    "# Context",
    "",
    "## Guardian",
    "",
    readContext("memory/relationship/GUARDIAN.md") ?? "Guardian profile unavailable.",
  ];

  if (ctx.bondLevel !== "guardian") {
    sections.push("", "## Sender info", "", buildSenderInfo(ctx));
  }

  return sections.join("\n");
}

export function parseSentinelDecision(raw: string): SentinelDecision {
  const trimmed = raw.trim();
  if (!trimmed) return { action: "escalated" };

  const directReply = trimmed.match(/^\s*REPLY\s*:\s*([\s\S]*)$/i);
  const directTerminal = trimmed.match(/^\s*(ESCALATE|IGNORE)\s*$/i);
  const labeled = trimmed.match(/(?:^|\n)\s*Decision\s*:\s*(REPLY|ESCALATE|IGNORE)\b/i);
  const match = directReply ?? directTerminal ?? labeled;
  if (!match) return { action: "escalated" };

  const decision = directReply ? "REPLY" : match[1].toUpperCase();
  if (decision === "ESCALATE") return { action: "escalated" };
  if (decision === "IGNORE") return { action: "ignored" };

  const explicitResponse = trimmed.match(/(?:^|\n)\s*(?:Response|Reply)\s*:\s*([\s\S]*)$/i);
  const rawResponse = (explicitResponse?.[1] ?? directReply?.[1] ?? "").trim();
  const conflictingDecision = rawResponse.match(/(?:^|\s)decision\s*:/i);
  if (conflictingDecision) return { action: "escalated" };
  const conflictingTerminal = rawResponse.match(/(?:^|\n)\s*(?:ESCALATE|IGNORE)\s*(?:\n|$)/i);
  if (conflictingTerminal) return { action: "escalated" };

  const internalLabelIndex = rawResponse.search(
    /(?:^|\s)(?:analysis|reason(?:ing)?|rationale)\s*:/i,
  );
  const response = (
    internalLabelIndex >= 0 ? rawResponse.slice(0, internalLabelIndex) : rawResponse
  ).trim();
  if (!response) {
    return { action: "escalated" };
  }
  return { action: "replied", response };
}

async function envoyCheck(
  runner: AgentRunnerInterface,
  outgoingText: string,
  originalMessage: string,
  bondLevel: string,
  workingDir?: string,
): Promise<{ action: "approve" | "reject" | "require_approval"; reason?: string }> {
  const prompt = [
    `Validate this outgoing message before it is sent.`,
    ``,
    `Original user message: ${originalMessage}`,
    `Bond level: ${bondLevel}`,
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

  const envoyOutput = envoyResult.content;
  const upper = envoyOutput.toUpperCase();
  if (upper.includes("REQUIRE_APPROVAL") || upper.includes("REQUIRE APPROVAL")) {
    return { action: "require_approval", reason: envoyOutput };
  }
  if (upper.includes("REJECT")) {
    return { action: "reject", reason: envoyOutput };
  }
  return { action: "approve", reason: envoyOutput };
}

async function collectAgentResult(
  runner: AgentRunnerInterface,
  params: Parameters<AgentRunnerInterface["run"]>[0],
  emitAgentMessage?: (message: StreamAgentMessage) => void,
  agentName?: string,
): Promise<CollectedAgentResult> {
  let response = "";
  let lastError = "";
  let turnId: string | undefined;
  for await (const msg of runner.run(params)) {
    if (msg.type === "turn_start") {
      turnId = msg.turnId;
    }
    if (msg.type === "result") response = msg.content;
    if (msg.type === "error") lastError = msg.error;
    emitAgentMessage?.({ ...msg, agent: agentName });
  }
  if (!response && lastError) {
    log.warn("agent returned error instead of result", { agentName, error: lastError });
    return { success: false, error: lastError };
  }
  return { success: true, content: response, turnId };
}

function requireConversationRepository(deps: MessageHandlerRuntimeDeps): ConversationRepository {
  const repository = deps.appContext.repositories.conversations;
  if (!repository) throw new Error("Conversation repository is unavailable");
  return repository;
}

async function resolveRequestedAgent(
  deps: MessageHandlerRuntimeDeps,
  requestedAgent: string,
): Promise<string> {
  if (requestedAgent === "main") return "main";
  try {
    return (await deps.agentRunner.hasAgent?.(requestedAgent)) === false ? "main" : requestedAgent;
  } catch (err) {
    log.warn("hasAgent check failed; honoring requested agent", {
      requestedAgent,
      error: err instanceof Error ? err.message : String(err),
    });
    return requestedAgent;
  }
}

// ---------------------------------------------------------------------------
// Auto-map unknown sender by display name
// ---------------------------------------------------------------------------

async function autoMapUnknownSender(
  deps: MessageHandlerDeps,
  channel: string,
  channelUserId: string,
  displayName: string,
) {
  if (!displayName) return null;

  const candidate = await deps.personMappingRepo.findByNameFuzzy(displayName);
  if (!candidate) return null;

  if (candidate.id === deps.strangerPersonId) return null;

  await deps.personMappingRepo.addChannelMapping(candidate.id, channel, channelUserId, displayName);

  await deps.approvalsRepo.create({
    type: "person_mapping",
    requestedBy: "system",
    description: `Auto-mapped ${displayName} (${channel}:${channelUserId}) to existing person "${candidate.displayName}"`,
    payload: {
      action: "auto_mapped_existing",
      personId: candidate.id,
      personDisplayName: candidate.displayName,
      channel,
      channelUserId,
      senderDisplayName: displayName,
    },
  });

  log.info("auto-mapped unknown sender to existing person", {
    channel,
    channelUserId,
    displayName,
    personId: candidate.id,
    personDisplayName: candidate.displayName,
  });

  return deps.personMappingRepo.findByChannelUser(channel, channelUserId);
}

// ---------------------------------------------------------------------------
// Trusted path: main agent -> envoy check -> send / approval gate
// ---------------------------------------------------------------------------

async function handleTrustedMessage(
  deps: MessageHandlerRuntimeDeps,
  args: Record<string, unknown>,
  channelThreadKey: string,
  contextSuffix: string,
  conversationId: string,
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

  log.info("running agent (trusted path)", {
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
      romeSessionId: conversationId,
      platformMessageId: messageId,
      replyTo: parseMessageReplyReference(args.replyTo),
      threadContext: {
        connectionId,
        channel,
        threadId,
        parentThreadId: typeof args.parentThreadId === "string" ? args.parentThreadId : undefined,
        romeSessionId: conversationId,
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
        // guardian-only "no AI tool configured" notice to the guardian (other
        // trusted senders reach this same path).
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

  // Skip envoy for guardian — send directly
  if (bondLevel === "guardian") {
    log.info("skipping envoy (guardian)", { channel, channelUserId });
    await deps.appContext.runAction("send_message", {
      connectionId,
      channel,
      threadId,
      text: response,
      channelUserId,
      replyToMessageId: messageId,
      romeSessionId: conversationId,
      ...(mainResult.turnId ? { turnId: mainResult.turnId } : {}),
      knownToProvider: true,
    });
    await deps.approvalsRepo.create({
      type: "outgoing_message",
      requestedBy: targetAgent,
      description: "Skipped envoy (guardian)",
      payload: { response, channel, threadId, messageId, channelUserId },
      status: "auto_approved",
    });
    return { status: "ok", data: { action: "sent", response } };
  }

  // Envoy check before sending (non-guardian trusted senders)
  log.info("running envoy check", { channel, channelUserId });
  const envoyResult = await envoyCheck(deps.agentRunner, response, text, bondLevel, workingDir);
  log.info("envoy decision", { action: envoyResult.action, channel, channelUserId });

  if (envoyResult.action === "approve") {
    await deps.appContext.runAction("send_message", {
      connectionId,
      channel,
      threadId,
      text: response,
      channelUserId,
      replyToMessageId: messageId,
      romeSessionId: conversationId,
      ...(mainResult.turnId ? { turnId: mainResult.turnId } : {}),
      knownToProvider: true,
    });
    await deps.approvalsRepo.create({
      type: "outgoing_message",
      requestedBy: targetAgent,
      description: envoyResult.reason ?? "Envoy approved",
      payload: { response, channel, threadId, messageId, channelUserId },
      status: "auto_approved",
    });
    return { status: "ok", data: { action: "sent", response } };
  }

  if (envoyResult.action === "require_approval") {
    await deps.approvalsRepo.create({
      type: "outgoing_message",
      requestedBy: targetAgent,
      description: envoyResult.reason ?? "Envoy flagged for approval",
      payload: { response, channel, threadId, messageId, channelUserId },
    });
    return { status: "ok", data: { action: "pending_approval", response } };
  }

  // Rejected
  await deps.approvalsRepo.create({
    type: "outgoing_message",
    requestedBy: targetAgent,
    description: envoyResult.reason ?? "Envoy rejected",
    payload: { response, channel, threadId, messageId, channelUserId },
    status: "rejected",
  });
  return {
    status: "ok",
    data: { action: "rejected_by_envoy", reason: envoyResult.reason },
  };
}

// ---------------------------------------------------------------------------
// Untrusted path: sentinel -> reply / ignore / escalate
// ---------------------------------------------------------------------------

async function handleUntrustedMessage(
  deps: MessageHandlerRuntimeDeps,
  args: Record<string, unknown>,
  channelThreadKey: string,
  contextSuffix: string,
  conversationId: string,
  targetAgent: string,
): Promise<ActionResult> {
  const { connectionId, channel, channelUserId, threadId, text, messageId, displayName } =
    args as Record<string, string>;
  const bondLevel = (args.bondLevel as string) ?? "other";
  const workingDir =
    typeof args.workingDir === "string" && args.workingDir.trim() ? args.workingDir : undefined;
  log.info("running sentinel (untrusted path)", { channel, channelUserId, bondLevel, displayName });

  const sentinelResult = await collectAgentResult(
    deps.agentRunner,
    {
      agentName: "sentinel",
      prompt: `Triage this message from ${displayName} (${bondLevel}):\n\n${text}`,
      channelThreadKey: `sentinel:${channelThreadKey}`,
      contextSuffix,
      workingDir,
    },
    deps.emitAgentMessage,
    "sentinel",
  );

  if (!sentinelResult.success) {
    log.warn("sentinel failed; escalating to trusted path", {
      channel,
      channelUserId,
      error: sentinelResult.error,
    });
    await requireConversationRepository(deps).promoteMessageToUser(conversationId, messageId);
    return handleTrustedMessage(
      deps,
      { ...args, bondLevel },
      channelThreadKey,
      contextSuffix,
      conversationId,
      targetAgent,
    );
  }

  const sentinelOutput = sentinelResult.content;
  const decision = parseSentinelDecision(sentinelOutput);
  log.info("sentinel decision", { action: decision.action, channel, channelUserId });

  await deps.sentinelLogRepo.create({
    messageId: messageId ?? "",
    channel,
    channelUserId,
    displayName,
    threadId,
    text,
    action: decision.action,
    response: decision.response,
  });

  if (decision.action === "replied" && decision.response) {
    await deps.appContext.runAction("send_message", {
      connectionId,
      channel,
      threadId,
      text: decision.response,
      channelUserId,
      replyToMessageId: messageId,
      romeSessionId: conversationId,
      knownToProvider: false,
    });
    return { status: "ok", data: { action: "sentinel_replied" } };
  }

  if (decision.action === "escalated") {
    await requireConversationRepository(deps).promoteMessageToUser(conversationId, messageId);
    return handleTrustedMessage(
      deps,
      { ...args, bondLevel },
      channelThreadKey,
      contextSuffix,
      conversationId,
      targetAgent,
    );
  }

  return { status: "ok", data: { action: "sentinel_ignored" } };
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

        let person = (personOverride ?? null) as PersonRecord | null;
        if (!personOverride) {
          person = (await deps.personMappingRepo.findByChannelUser(
            channel,
            channelUserId,
          )) as PersonRecord | null;

          if (!person) {
            person = (await autoMapUnknownSender(
              deps,
              channel,
              channelUserId,
              displayName,
            )) as PersonRecord | null;
          }
        }

        const bondLevel = (person?.bondLevel as string) ?? "other";

        const policy = await deps.policyEngine.evaluate({
          channel,
          sender: person ? { id: person.id, bondLevel: person.bondLevel } : null,
          bondLevel,
          threadName,
          threadType,
        });

        if (policy.action === "block") {
          log.info("message blocked by policy", { channel, channelUserId });
          return { status: "ok", data: { action: "blocked" } };
        }

        const settings = deps.appContext.repositories.settings;
        const conversations = requireConversationRepository(deps);
        const requestedAgent =
          typeof args.routedAgentName === "string" && args.routedAgentName.trim()
            ? args.routedAgentName.trim()
            : "main";
        const initialAgent = await resolveRequestedAgent(deps, requestedAgent);
        const parentThreadId =
          typeof args.parentThreadId === "string" && args.parentThreadId
            ? args.parentThreadId
            : undefined;
        const conversation = await conversations.ensureChannelConversation({
          channel,
          threadId,
          parentThreadId,
          threadName,
          threadType: threadType === "private" || threadType === "group" ? threadType : undefined,
          agentName: initialAgent,
          projectName: selectedProjectName,
          projectPath: selectedProjectPath,
        });
        // Root conversations retain their persisted binding. Native thread
        // sessions are refreshed by the repository from their parent binding.
        const targetAgent = conversation.agentName ?? "main";
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
        const replyToLevels =
          (await settings.get<string[]>("replyToBondLevels")) ?? DEFAULT_REPLY_TO_BOND_LEVELS;
        if (!canReplyToBondLevel(bondLevel, replyToLevels)) {
          const stored = await conversations.addMessage({
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
          log.info("message ignored by reply-to bond-level setting", {
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

        const enrichedArgs = { ...args, text: promptText, bondLevel, replyTo };

        const trustedLevels =
          (await settings.get<string[]>("trustedBondLevels")) ?? DEFAULT_TRUSTED_BOND_LEVELS;

        const trusted = isTrustedBondLevel(bondLevel, trustedLevels);
        const triggersTargetAgent = trusted || policy.action === "allow";
        const stored = await conversations.addMessage({
          sessionId: conversation.id,
          role: triggersTargetAgent ? "user" : "notification",
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
          trusted,
          bondLevel,
          policyAction: policy.action,
        });

        if (triggersTargetAgent) {
          return handleTrustedMessage(
            deps,
            enrichedArgs,
            channelThreadKey,
            contextSuffix,
            conversation.id,
            targetAgent,
          );
        }

        return handleUntrustedMessage(
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

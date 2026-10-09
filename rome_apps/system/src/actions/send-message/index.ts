import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createAppLogger, getCurrentActionContext, isCoreMainAgentId } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  ConversationId,
  ConversationRepository,
  MessageReceipt,
  ChannelsService,
  PreviewPayload,
} from "@rome-os/app-runtime";
import type { SendMessageInput, SendMessageChatInput, SendMessageEmailInput } from "./types.js";
export type { SendMessageInput, SendMessageOutput } from "./types.js";

const log = createAppLogger("send-message");

// Adapter names are internal ids; the preview card shows a human label instead.
// Unknown channels fall back to the raw name rather than failing — a preview is
// advisory, never a gate.
const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram",
  telegram_user: "Telegram",
  whatsapp: "WhatsApp",
  wechat: "WeChat",
  discord: "Discord",
  webchat: "Web chat",
  email: "Email",
  agents: "Agents",
};

type GuardianPerson = {
  channelMappings: { channel: string; channelUserId: string }[];
};

interface PersonMappingResolver {
  findByBondLevel(bondLevel: "guardian"): Promise<GuardianPerson[]>;
}

/** Core's agent-name lookup, handed to the system app alone. Declared here
 *  because an app cannot import core, and a worker receives a proxy. */
export interface AgentNamesService {
  resolve(
    name: string,
  ): Promise<
    | { status: "found"; agentId: string }
    | { status: "ambiguous"; matches: { label: string; agentId: string }[] }
    | { status: "none" }
    | { status: "not_connected" }
  >;
}

interface SendMessageRuntimeDeps {
  personMappingRepo?: PersonMappingResolver;
  conversations?: ConversationRepository;
  agentNames?: AgentNamesService;
}

function outboundContent(input: SendMessageInput): string {
  const parts = input.parts?.length
    ? [...input.parts]
    : input.text
      ? [{ type: "text" as const, content: input.text }]
      : [];
  for (const attachment of input.attachments ?? []) {
    const label = attachment.caption
      ? `${attachment.caption}: ${attachment.source}`
      : attachment.source;
    parts.push({ type: "text", content: `[${attachment.type}] ${label}` });
  }
  return JSON.stringify(parts);
}

async function recordDeliveredConversationMessage(
  deps: SendMessageRuntimeDeps,
  input: SendMessageInput,
  threadId: string,
  delivery: MessageReceipt,
): Promise<void> {
  if (!deps.conversations || !threadId) return;
  const current = getCurrentActionContext();
  const requestedThreadId = input.threadId;
  const deliveryCreatedThread = !!requestedThreadId && requestedThreadId !== threadId;
  const sameAmbientConversation =
    current?.channelContext?.channel === input.channel &&
    current.channelContext.threadId === threadId;
  const explicitRomeSessionId = deliveryCreatedThread ? undefined : input.romeSessionId;
  const ambientRomeSessionId = sameAmbientConversation
    ? current?.channelContext?.romeSessionId
    : undefined;
  const boundRomeSessionId = explicitRomeSessionId ?? ambientRomeSessionId;
  const conversation = boundRomeSessionId
    ? { id: boundRomeSessionId, agentName: null }
    : await deps.conversations.ensureChannelConversation({
        channel: input.channel,
        threadId,
        parentThreadId: deliveryCreatedThread ? requestedThreadId : undefined,
        // A delivery must not implicitly bind an unclaimed conversation to
        // whichever background/sentinel agent happened to send first.
        agentName: "main",
        threadType: deliveryCreatedThread ? "group" : "private",
      });
  const knownToProvider =
    !deliveryCreatedThread &&
    (input.knownToProvider ??
      Boolean(input.turnId || (sameAmbientConversation && current?.turnId)));
  await deps.conversations.recordOutboundMessage({
    sessionId: conversation.id,
    content: outboundContent(input),
    platformMessageId: delivery?.messageId,
    senderId: "rome",
    senderName: "Rome",
    replyToPlatformMessageId: input.replyToMessageId,
    turnId: input.turnId ?? current?.turnId,
    knownToProvider,
  });
}

async function recordDeliveredConversationMessageBestEffort(
  deps: SendMessageRuntimeDeps,
  input: SendMessageInput,
  threadId: string,
  delivery: MessageReceipt,
): Promise<void> {
  try {
    await recordDeliveredConversationMessage(deps, input, threadId, delivery);
  } catch (err) {
    // Transport delivery already succeeded. Do not convert a transcript-write
    // failure into a retryable send error that could duplicate the message.
    log.warn("message delivered but conversation recording failed", {
      channel: input.channel,
      threadId,
      messageId: delivery?.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readEnvPath(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}

function getProfileDir(): string {
  return join(homedir(), ".rome", process.env.ROME_PROFILE || "default");
}

function getAllowedAttachmentRoots(): string[] {
  const projectsRoot =
    readEnvPath("ROME_PROJECTS_ROOT") ??
    readEnvPath("ROME_WEBCHAT_PROJECTS_ROOT") ??
    join(getProfileDir(), "projects");

  return [projectsRoot, join(getProfileDir(), "memory", "channel-attachments")];
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!!path && !path.startsWith("..") && !isAbsolute(path));
}

async function validateAttachmentSource(source: string): Promise<string> {
  if (!source.trim()) {
    throw new Error("Attachment source is required");
  }
  if (!isAbsolute(source)) {
    throw new Error("Attachment source must be an absolute local path");
  }

  let sourceRealPath: string;
  try {
    sourceRealPath = await realpath(source);
    const sourceStat = await stat(sourceRealPath);
    if (!sourceStat.isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error("Attachment source must reference an existing local file");
  }
  const allowedRoots = await Promise.all(
    getAllowedAttachmentRoots().map(async (root) => {
      try {
        return await realpath(resolve(root));
      } catch {
        return null;
      }
    }),
  );

  if (!allowedRoots.some((root) => root && isPathInside(root, sourceRealPath))) {
    throw new Error(
      "Attachment source must be under a Rome project workspace or channel attachment directory",
    );
  }

  return sourceRealPath;
}

async function validateAttachmentSources(input: SendMessageInput): Promise<SendMessageInput> {
  if (!input.attachments?.length) return input;

  const attachments = await Promise.all(
    input.attachments.map(async (attachment) => ({
      ...attachment,
      source: await validateAttachmentSource(attachment.source),
    })),
  );

  return { ...input, attachments };
}

async function resolveGuardianThreadId(
  channel: SendMessageChatInput["channel"],
  deps: SendMessageRuntimeDeps,
): Promise<string> {
  if (!deps.personMappingRepo) {
    throw new Error(
      `Channel "${channel}" recipient "guardian" requires a person mapping repository`,
    );
  }

  const guardians = await deps.personMappingRepo.findByBondLevel("guardian");
  const mapping = guardians
    .flatMap((guardian) => guardian.channelMappings)
    .find((candidate) => candidate.channel === channel);

  if (!mapping) {
    throw new Error(`No guardian mapping found for channel "${channel}"`);
  }

  return mapping.channelUserId;
}

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An agent's id from its name, for `to` on `agents`. Cloud lists the
 * guardian's agents and linked accounts' agents, so only Rome's main agent
 * looks a name up there; any other caller passes the id. A name two agents
 * share is refused with each one's label and id rather than guessed between.
 */
async function resolveAgentThreadId(name: string, deps: SendMessageRuntimeDeps): Promise<string> {
  const wanted = name.trim();
  if (AGENT_ID.test(wanted)) return wanted.toLowerCase();
  const context = getCurrentActionContext();
  // `main` is a name only core may define, so an installed app's agent cannot
  // take it; an app calling through runAction is refused the same way.
  const fromApp = !!context?.callerAppId && context.callerAppId !== "system";
  if (fromApp || !context?.agentName || !isCoreMainAgentId(context.agentName)) {
    throw new Error("Only Rome's main agent sends to an agent by name; pass its id as `threadId`");
  }
  if (!deps.agentNames) {
    throw new Error(
      "Sending to an agent by name is not available in this Rome; pass its id as `threadId`",
    );
  }
  const found = await deps.agentNames.resolve(wanted);
  switch (found.status) {
    case "found":
      return found.agentId;
    case "not_connected":
      throw new Error('Channel "agents" is not connected');
    case "none":
      throw new Error(`No agent named "${wanted}"`);
    case "ambiguous": {
      const options = found.matches
        .map((match) => `"${match.label}" (threadId ${match.agentId})`)
        .join(", ");
      // Two agents of one account can share a whole label, which then names
      // neither, so only distinct labels are offered as a way to pick.
      const labels = new Set(found.matches.map((match) => match.label.toLowerCase()));
      const retry =
        labels.size === found.matches.length
          ? "Send again with the full name as `to` or the id as `threadId`."
          : "Send again with the id as `threadId`.";
      throw new Error(`More than one agent is named "${wanted}": ${options}. ${retry}`);
    }
  }
}

async function resolveChatThreadId(
  chat: SendMessageChatInput,
  deps: SendMessageRuntimeDeps,
): Promise<string> {
  if (chat.channel === "agents" && typeof chat.to === "string" && chat.to !== "guardian") {
    return resolveAgentThreadId(chat.to, deps);
  }
  if (chat.to !== undefined && chat.to !== "guardian") {
    throw new Error(
      `Channel "${chat.channel}" only supports to: "guardian"; use threadId for explicit recipients`,
    );
  }
  if (chat.to === "guardian") return resolveGuardianThreadId(chat.channel, deps);
  if (chat.threadId) return chat.threadId;
  throw new Error(`Channel "${chat.channel}" requires a threadId or to: "guardian"`);
}

/**
 * Refuse a channel no Connection can send on before anything else is checked,
 * so an unconfigured channel is not reported as a bad attachment or a missing
 * guardian mapping. The text is the one the channels service rejects with.
 */
async function requireSendableChannel(channels: ChannelsService, channel: string): Promise<void> {
  const target = (await channels.list()).find((candidate) => candidate.name === channel);
  if (!target?.sendable) throw new Error(`No Talk connection registered for "${channel}"`);
}

export async function executeSendMessage(
  channels: ChannelsService,
  input: SendMessageInput,
  deps: SendMessageRuntimeDeps = {},
): Promise<ActionResult> {
  const { channel, text, attachments, turnId, parts } = input;
  const hasAttachments = !!attachments && attachments.length > 0;
  const hasParts = !!parts && parts.length > 0;

  await requireSendableChannel(channels, channel);

  const safeInput = await validateAttachmentSources(input);

  if (channel === "email") {
    const email = input as SendMessageEmailInput;
    const hasHtml = !!email.html?.trim();
    if (!text && !hasHtml && !hasAttachments) {
      throw new Error("Email requires `text`, `html`, or `attachments`");
    }
    // Reply on a thread, or start a new email to `to` — one must be present.
    const replyTarget = email.replyToMessageId;
    if (!email.threadId && !replyTarget && !email.to) {
      throw new Error("Email needs a `threadId`/`replyToMessageId` to reply, or a `to` recipient");
    }

    const threadId = email.threadId ?? "";
    log.info("sending email", {
      threadId: threadId || null,
      reply: !!(email.threadId || replyTarget),
      attachmentCount: attachments?.length ?? 0,
    });
    const delivery = await channels.send(channel, threadId as ConversationId, {
      kind: "email",
      text,
      parts,
      attachments: safeInput.attachments,
      turnId,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      subject: email.subject,
      html: email.html,
      inReplyToMessageId: replyTarget,
    });
    const deliveredThreadId = delivery.conversationId;
    await recordDeliveredConversationMessageBestEffort(deps, input, deliveredThreadId, delivery);
    return delivery.messageId
      ? { status: "ok", data: { messageId: delivery.messageId, threadId: deliveredThreadId } }
      : { status: "ok" };
  }

  const chat = input as SendMessageChatInput;
  if (!text && !hasAttachments && !hasParts) {
    throw new Error("At least one of `text`, `attachments`, or `parts` must be provided");
  }
  const threadId = await resolveChatThreadId(chat, deps);
  const channelUserId = chat.channelUserId ?? threadId;

  log.info("sending message", {
    channel,
    threadId,
    channelUserId,
    attachmentCount: attachments?.length ?? 0,
  });
  const delivery = await channels.send(channel, threadId as ConversationId, {
    text,
    parts,
    attachments: safeInput.attachments,
    replyToMessageId: chat.replyToMessageId,
    turnId,
  });
  await recordDeliveredConversationMessageBestEffort(
    deps,
    input,
    delivery.conversationId,
    delivery,
  );
  return delivery.messageId
    ? { status: "ok", data: { messageId: delivery.messageId } }
    : { status: "ok" };
}

/**
 * Creates the send_message action for use in the registry.
 */
export function createSendMessageAction(
  config: ActionConfig,
  channels: ChannelsService,
  deps: SendMessageRuntimeDeps = {},
): Action {
  return {
    config,
    inputSchema: {
      properties: {
        channel: {
          type: "string",
          enum: [
            "telegram",
            "telegram_user",
            "whatsapp",
            "wechat",
            "discord",
            "webchat",
            "email",
            "feishu",
            "agents",
          ],
          description:
            'Registered channel adapter name, e.g. "telegram", "whatsapp", "discord", "feishu", or "email". "agents" messages an agent on Rome Cloud, such as a dot, in this account or a linked one: pass its id (a UUID, the threadId its messages arrive on) as `threadId`, or, from the main agent, its name as `to`.',
        },
        threadId: {
          type: "string",
          description:
            'The thread/chat ID to send to. Required for chat channels unless using `to: "guardian"`. For email, pass it to reply on an existing thread; omit it (and set `to`) to start a new email.',
        },
        text: {
          type: "string",
          description:
            "The message text to send (supports markdown). Optional when attachments are provided.",
        },
        channelUserId: {
          type: "string",
          description: "The recipient user ID. Defaults to threadId if not provided.",
        },
        replyToMessageId: {
          type: "string",
          description:
            "Optional message ID to reply to. For email this is the inbound message id that keeps the reply on-thread.",
        },
        to: {
          type: ["string", "array"],
          items: { type: "string" },
          description:
            'Recipient alias/address. For chat channels, the literal "guardian" resolves through the guardian\'s channel mapping, and on "agents" the main agent can give an agent\'s name, which resolves to its id. For email, pass recipient address(es); the literal "guardian" resolves to the guardian\'s address. Omit when replying on a thread.',
        },
        subject: {
          type: "string",
          description: "Email only — subject line for a new email. Ignored for on-thread replies.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "Email only — CC recipient addresses.",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "Email only — BCC recipient addresses.",
        },
        html: {
          type: "string",
          description:
            "Email only — a raw HTML body (e.g. a generated report). Sanitized before sending. When omitted, `text` (markdown) is rendered to HTML automatically.",
        },
        attachments: {
          type: "array",
          description:
            "Optional file attachments to send. Sources must be absolute paths under a Rome project workspace or channel attachment directory.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["image", "video", "audio", "document"],
                description: "Attachment media type.",
              },
              source: {
                type: "string",
                description:
                  "Absolute local file path under a Rome project workspace or channel attachment directory.",
              },
              caption: {
                type: "string",
                description: "Optional caption.",
              },
            },
            required: ["type", "source"],
          },
        },
      },
      required: ["channel"],
    },
    execute: async (input: Record<string, unknown>): Promise<ActionResult> =>
      executeSendMessage(channels, input as unknown as SendMessageInput, deps),
    // Ground-truth render of the bound call. Pure over args (no I/O), so it
    // surfaces the message body and channel — the decision-relevant facts — but
    // deliberately omits the raw threadId/channelUserId recipient, which would
    // need a lookup to humanize and must never reach the UI as an internal id.
    preview(args: Record<string, unknown>): PreviewPayload {
      const input = args as Partial<SendMessageInput>;
      const channel = typeof input.channel === "string" ? input.channel : undefined;
      return {
        kind: "generic",
        title: "Send a message",
        summary: typeof input.text === "string" && input.text ? input.text : "(no message text)",
        ...(channel
          ? { fields: [{ label: "Channel", value: CHANNEL_LABELS[channel] ?? channel }] }
          : {}),
      };
    },
  };
}

export function createAction(
  config: ActionConfig,
  deps: { channelsService: ChannelsService } & SendMessageRuntimeDeps & {
      appContext?: { repositories?: { conversations?: ConversationRepository } };
    },
): Action {
  return createSendMessageAction(config, deps.channelsService, {
    ...deps,
    conversations: deps.conversations ?? deps.appContext?.repositories?.conversations,
  });
}

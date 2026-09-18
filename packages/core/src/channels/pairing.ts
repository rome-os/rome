import type { ConversationId, InboundMessage, TalkRouter } from "@rome-os/app-runtime";
import { pairingPayload, pairingPayloadSchema } from "@rome/api-types/approvals";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { createLogger } from "../logger.js";
import { STRANGER_PERSON_ID } from "../constants.js";
import { isPairingCodeMessage } from "./pairing-code.js";

const log = createLogger("channel-pairing");
const ADDRESSED_GROUP_KINDS = ["mention", "reply", "bot_thread"] as const;

function canReplyInOriginatingConversation(
  message: InboundMessage,
  allowAddressedGroup: boolean,
): boolean {
  return (
    message.thread?.kind === "dm" ||
    (allowAddressedGroup &&
      ADDRESSED_GROUP_KINDS.includes(message.addressing as (typeof ADDRESSED_GROUP_KINDS)[number]))
  );
}

function pairingAccount(
  channel: string,
  id: string,
  displayName?: string,
  username?: string,
  plainText = false,
): string {
  const name = username ? `@${username}` : displayName?.replace(/\s+/g, " ").trim();
  const code = `\`${id}\``;
  if (plainText) return name && name !== id ? `${name} (${id})` : id;
  if (channel === "discord" && /^[1-9][0-9]*$/.test(id)) return `<@${id}> (${code})`;
  if (channel === "feishu" && /^ou_[a-zA-Z0-9_-]+$/.test(id)) {
    const label = (displayName || id)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<at user_id="${id}">${label}</at> (${code})`;
  }
  if (channel === "telegram" && !username && /^[1-9][0-9]*$/.test(id)) {
    const label = (name || id).replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
    return `[@${label}](tg://user?id=${id}) (${code})`;
  }
  return name && name !== id
    ? `${name.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&")} (${code})`
    : code;
}

function pairingSuccess(
  channel: string,
  id: string,
  displayName?: string,
  username?: string,
  plainText = false,
): string {
  return `✅ ${pairingAccount(channel, id, displayName, username, plainText)} is paired with Rome. You can start chatting now.`;
}

export function createPairingAdmission(deps: {
  approvalsRepo: ApprovalsRepository;
  personMappingRepo: PersonMappingRepository;
  talkGrants: (service: string) => readonly string[];
  replyInOriginatingConversation?: (service: string) => boolean;
  plainTextGuidance?: (service: string) => boolean;
}) {
  return async (
    connectionId: string,
    service: string,
    message: InboundMessage,
    router: TalkRouter,
  ): Promise<boolean> => {
    const channel = pairingPayloadSchema.shape.channel.safeParse(service);
    if (!channel.success) return true;
    const pairingChannel = channel.data;
    const allowAddressedGroup = deps.replyInOriginatingConversation?.(service) ?? false;
    const plainTextGuidance = deps.plainTextGuidance?.(service) ?? false;
    if (service === "telegram" && !/^[1-9][0-9]*$/.test(message.senderId)) return false;
    const displayName = message.senderDisplayName ?? message.senderId;
    const guideUrl = `https://romeos.cc/docs/rome/${service === "feishu" ? "lark" : service}`;
    const guidance = plainTextGuidance
      ? `🔗 Pair ${pairingAccount(service, message.senderId, displayName, message.senderUsername, true)} with Rome.\n\nOpen Settings → Connections in the Rome Web UI.\n\nPairing Guide: ${guideUrl}`
      : `🔗 Pair ${pairingAccount(service, message.senderId, displayName, message.senderUsername)} with Rome.\n\nOpen \`Settings\` → \`Connections\` in the Rome Web UI.\n\nLearn more in the [Pairing Guide](${guideUrl}).`;
    try {
      if (isPairingCodeMessage(message.text)) {
        if (message.thread?.kind !== "dm") {
          const request = deps.approvalsRepo.requestAuthorizedPairing(
            {
              channel: pairingChannel,
              connectionId,
              channelUserId: message.senderId,
              displayName,
              username: message.senderUsername,
              ...(canReplyInOriginatingConversation(message, allowAddressedGroup)
                ? { conversationId: message.conversationId }
                : {}),
            },
            deps.talkGrants(service),
          );
          if (request?.guide)
            await router.send(connectionId, message.conversationId, { text: guidance });
          return false;
        }
        const result = deps.approvalsRepo.verifyPairing({
          connectionId,
          channel: pairingChannel,
          channelUserId: message.senderId,
          code: message.text!,
        });
        log.info("pairing verification", {
          connectionId,
          senderId: message.senderId,
          outcome: result.outcome,
        });
        if (result.outcome === "resolved" && result.approval.status === "approved") {
          await router.send(connectionId, message.conversationId, {
            text: pairingSuccess(
              service,
              message.senderId,
              displayName,
              message.senderUsername,
              plainTextGuidance,
            ),
          });
        }
        if (result.outcome === "invalid_code" && "notify" in result && result.notify) {
          await router.send(connectionId, message.conversationId, {
            text: "The code was not accepted. Check the pending request in Settings → Connections or Activity. After five failed attempts, ask the guardian to approve it there.",
          });
        }
        return false;
      }
      const person = await deps.personMappingRepo.findByChannelUser(service, message.senderId);
      if (person && person.id !== STRANGER_PERSON_ID) return true;
      if (
        message.thread?.kind !== "dm" &&
        !ADDRESSED_GROUP_KINDS.includes(
          message.addressing as (typeof ADDRESSED_GROUP_KINDS)[number],
        )
      )
        return false;
      const request = deps.approvalsRepo.requestAuthorizedPairing(
        {
          channel: pairingChannel,
          connectionId,
          channelUserId: message.senderId,
          displayName,
          username: message.senderUsername,
          ...(canReplyInOriginatingConversation(message, allowAddressedGroup)
            ? { conversationId: message.conversationId }
            : {}),
        },
        deps.talkGrants(service),
      );
      if (request?.guide) {
        await router.send(connectionId, message.conversationId, { text: guidance });
        log.info("pairing guidance sent", { approvalId: request.approval.id, connectionId });
      }
      return false;
    } catch {
      // Provider errors may include the rejected request body. Do not log them.
      log.error("pairing admission failed", { connectionId, senderId: message.senderId });
      return false;
    }
  };
}

export async function notifyPairingResolution(
  router: TalkRouter,
  approval: { id: string; type: string; status: string; payload: unknown },
  plainTextGuidance: (service: string) => boolean = () => false,
) {
  const payload = pairingPayload(approval);
  if (!payload || approval.status !== "approved") return;
  try {
    const conversationId =
      (payload.conversationId as ConversationId | undefined) ??
      (await router
        .feature(payload.connectionId, "directMessaging")
        ?.conversationFor(payload.channelUserId));
    if (!conversationId) throw new Error("Direct conversation unavailable");
    await router.send(payload.connectionId, conversationId, {
      text: pairingSuccess(
        payload.channel,
        payload.channelUserId,
        payload.displayName,
        payload.username,
        plainTextGuidance(payload.channel),
      ),
    });
  } catch {
    log.warn("pairing notification failed", {
      approvalId: approval.id,
      connectionId: payload.connectionId,
    });
  }
}

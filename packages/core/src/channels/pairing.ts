import type { ConversationId, InboundMessage, TalkRouter } from "@rome-os/app-runtime";
import { pairingPayload, pairingPayloadSchema } from "@rome/api-types/approvals";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { createLogger } from "../logger.js";
import { isPairingCodeMessage } from "./pairing-code.js";

const log = createLogger("channel-pairing");
const SUCCESS = "Your account is paired with Rome. Please send your original message again.";
const GUIDANCE =
  "Pair your account using either option:\n\n" +
  "- Ask the guardian to approve it in `Settings` → `Connections`.\n" +
  "- Send the verification code to this bot (in a private chat).";

export function createPairingAdmission(deps: {
  approvalsRepo: ApprovalsRepository;
  personMappingRepo: PersonMappingRepository;
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
    if (service === "telegram" && !/^[1-9][0-9]*$/.test(message.senderId)) return false;
    const guidance = `${GUIDANCE}\n\nLearn more in the [pairing guide](https://romeos.cc/docs/rome/${service === "feishu" ? "lark" : service}).`;
    try {
      if (isPairingCodeMessage(message.text)) {
        if (message.thread?.kind !== "dm") {
          const request = deps.approvalsRepo.requestPairing({
            channel: pairingChannel,
            connectionId,
            channelUserId: message.senderId,
            displayName: message.senderDisplayName ?? message.senderId,
          });
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
          await router.send(connectionId, message.conversationId, { text: SUCCESS });
        }
        if (result.outcome === "invalid_code" && "notify" in result && result.notify) {
          await router.send(connectionId, message.conversationId, {
            text: "The code was not accepted. Check the pending request in Settings → Connections or Activity. After five failed attempts, ask the guardian to approve it there.",
          });
        }
        return false;
      }
      const person = await deps.personMappingRepo.findByChannelUser(service, message.senderId);
      if (person) return true;
      if (
        message.thread?.kind !== "dm" &&
        !["mention", "reply", "bot_thread"].includes(message.addressing ?? "ambient")
      )
        return false;
      const request = deps.approvalsRepo.requestPairing({
        channel: pairingChannel,
        connectionId,
        channelUserId: message.senderId,
        displayName: message.senderDisplayName ?? message.senderId,
        ...(message.thread?.kind === "dm" ? { conversationId: message.conversationId } : {}),
      });
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
    await router.send(payload.connectionId, conversationId, { text: SUCCESS });
  } catch {
    log.warn("pairing notification failed", {
      approvalId: approval.id,
      connectionId: payload.connectionId,
    });
  }
}

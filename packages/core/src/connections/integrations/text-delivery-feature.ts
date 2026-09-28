import type { TalkTextDelivery } from "@rome-os/app-runtime";
import type { DeliveryProfile } from "../delivery/profile.js";
import { DeliveryFailure, plainTextCodec, type TextCodec } from "../delivery/transport.js";
import { toMessageReceipt } from "./talk-features.js";

export function textDeliveryFeature(
  profile: DeliveryProfile,
  adapter: {
    createText(
      conversationId: string,
      text: string,
      replyToMessageId?: string,
    ): Promise<{ messageId?: string; threadId?: string } | void>;
    updateText?(conversationId: string, messageId: string, text: string): Promise<void>;
  },
  codec: TextCodec = plainTextCodec,
): TalkTextDelivery {
  return {
    render: ({ source, settled }) => codec.render(source, settled),
    measure: ({ text }) => codec.length(text),
    async describe() {
      return { profile, supportsUpdate: !!adapter.updateText };
    },
    async create(input) {
      return toMessageReceipt(
        input.conversationId,
        await adapter.createText(input.conversationId, input.text, input.replyToMessageId),
      );
    },
    async update({ receipt, text }) {
      if (!adapter.updateText)
        throw new DeliveryFailure("unsupported", "Text editing is unavailable");
      if (!receipt.messageId)
        throw new DeliveryFailure("unknown", "Physical message identity is unavailable");
      await adapter.updateText(receipt.conversationId, receipt.messageId, text);
    },
  };
}

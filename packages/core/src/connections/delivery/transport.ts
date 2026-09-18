import type { ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import { MessageDeliveryError } from "@rome-os/app-runtime";
import type { DeliveryProfile } from "./profile.js";

export type DeliveryFailureKind =
  | "rate-limit"
  | "formatting"
  | "unsupported"
  | "authorization"
  | "failed"
  | "unknown";

export class DeliveryFailure extends MessageDeliveryError {}

export interface TextCodec {
  render(source: string, settled: boolean): string;
  length(rendered: string): number;
}

export const plainTextCodec: TextCodec = {
  render: (source) => source,
  length: (rendered) => rendered.length,
};

export interface DeliveryTarget {
  conversationId: ConversationId;
  replyToMessageId?: string;
}

export interface TextTransport {
  profile: DeliveryProfile;
  codec: TextCodec;
  assertAuthorized(): void;
  create(target: DeliveryTarget, text: string): Promise<MessageReceipt>;
  update?(receipt: MessageReceipt, text: string): Promise<void>;
  /** Unknown edits may resume only after the provider establishes their ordering. */
  reconcile?(receipt: MessageReceipt): Promise<{ text: string; quiescent: boolean }>;
}

export interface DeliveryAttempt {
  runId: string;
  blockIx: number;
  partIx: number;
  sourceStart: number;
  sourceEnd: number;
  revision: number;
  target: DeliveryTarget;
  operation: "create" | "update" | "settle";
  outcome: "attempting" | "accepted" | "failed" | "unknown" | "stopped";
  receipt?: MessageReceipt;
}

export interface DeliveryRepository {
  record(attempt: DeliveryAttempt): Promise<void>;
}

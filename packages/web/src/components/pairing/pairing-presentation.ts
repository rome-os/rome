import type { PairingPayload } from "@rome/api-types/approvals";
import type { Approval } from "@/pages/ActivityPage";
import { serviceLabel } from "@/lib/connection-cards";
import type { PairingRequestCardProps } from "./pairing-views";

export function pairingPresentation(
  approval: Approval,
  payload: PairingPayload,
): PairingRequestCardProps {
  const status: PairingRequestCardProps["status"] =
    approval.status === "approved"
      ? "approved"
      : payload.resolution === "expired" || approval.status === "pending"
        ? "expired"
        : "rejected";
  return {
    name: payload.displayName || payload.channelUserId,
    accountId: payload.channelUserId,
    channel: serviceLabel(payload.channel),
    createdAt: approval.createdAt,
    expiresAt: payload.expiresAt,
    status,
    resolvedBy: approval.resolvedBy,
    resolvedAt: approval.resolvedAt,
  };
}

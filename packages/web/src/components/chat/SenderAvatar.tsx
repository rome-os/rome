import { Clock, UserRound } from "lucide-react";
import type { DashboardIdentity } from "@rome/api-types";
import type { ChatMessageSender } from "@rome/api-types/chat";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AgentAvatar } from "./AgentAvatar";

/** The signed-in person as the sender of a message they are sending now. */
export function senderFromIdentity(
  identity: DashboardIdentity | undefined,
): ChatMessageSender | undefined {
  if (identity?.kind === "guardian") {
    return { kind: "guardian", name: identity.displayName, avatarUrl: identity.avatarUrl };
  }
  if (identity?.kind === "visitor") {
    return {
      kind: "visitor",
      accountId: identity.accountId,
      name: identity.email,
      avatarUrl: identity.avatarUrl,
    };
  }
  return undefined;
}

/** On-behalf automation follows the person it speaks for. A message with no
 * recorded sender keeps its own-message layout, without naming a person. */
export function sentByViewer(
  sender: ChatMessageSender | undefined,
  viewer: DashboardIdentity | undefined,
): boolean {
  if (sender?.kind === "automated") {
    if (!sender.onBehalfOf) return false;
    sender = sender.onBehalfOf;
  }
  if (!sender || !viewer || viewer.kind === "anonymous") return true;
  if (sender.kind === "guardian") return viewer.kind === "guardian";
  return viewer.kind === "visitor" && viewer.accountId === sender.accountId;
}

/** A round avatar marks a person. A rounded square marks automation,
 * with a clock for a routine. */
export function SenderAvatar({ sender }: { sender: ChatMessageSender }) {
  if (sender.kind === "automated" && sender.onBehalfOf) sender = sender.onBehalfOf;
  if (sender.kind === "automated") {
    return (
      <AgentAvatar
        iconUrl={sender.iconUrl}
        label={sender.name}
        mark={
          sender.sourceType === "routine" ? <Clock className="size-4" aria-hidden /> : undefined
        }
      />
    );
  }
  const initial = sender.name?.trim().charAt(0).toUpperCase();
  return (
    <Avatar title={sender.name ?? undefined}>
      {sender.avatarUrl ? <AvatarImage src={sender.avatarUrl} alt={sender.name ?? ""} /> : null}
      <AvatarFallback className="bg-primary/15 text-primary">
        {initial || <UserRound className="size-4" aria-hidden />}
      </AvatarFallback>
    </Avatar>
  );
}

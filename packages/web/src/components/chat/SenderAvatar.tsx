import { UserRound } from "lucide-react";
import type { DashboardIdentity } from "@rome/api-types";
import type { ChatMessageSender } from "@rome/api-types/chat";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

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

/** Whether the signed-in person sent a message. A message that recorded no
 * sender counts as theirs, as it did before chats had more than one person. */
export function sentByViewer(
  sender: ChatMessageSender | undefined,
  viewer: DashboardIdentity | undefined,
): boolean {
  if (!sender || !viewer || viewer.kind === "anonymous") return true;
  if (sender.kind === "guardian") return viewer.kind === "guardian";
  return viewer.kind === "visitor" && viewer.accountId === sender.accountId;
}

/** A person's round avatar beside their chat message: their Rome Cloud
 * picture, else the first letter of their name. Round marks a person, as the
 * rounded square marks an agent. */
export function SenderAvatar({ sender }: { sender: ChatMessageSender }) {
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

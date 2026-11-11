import { createContext, useContext } from "react";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/** A message's own turn, as the place that draws it knows it. */
export interface SharedMessageTurn {
  sessionId: string;
  turnId?: string | null;
}

/**
 * Starts the chat's share mode with the turn of one message selected. The
 * live chat provides it; a shared chat and a read-only viewer leave it null,
 * so they show no Share. `turn` names the message's turn where the chat's
 * loaded timeline may not hold it, such as a thread view's older message.
 */
export const MessageSharingContext = createContext<
  ((messageId: string, turn?: SharedMessageTurn) => void) | null
>(null);

/**
 * Share on a message: a shortcut into the chat's share mode, with this
 * message's turn already selected. The link is made, copied and revoked in
 * the share bar, as for any chat share.
 */
export function ShareMessageButton({
  messageId,
  turn,
  size = "sm",
  className,
}: {
  messageId: string;
  /** The message's turn, when the caller has it. */
  turn?: SharedMessageTurn;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const startShare = useContext(MessageSharingContext);
  if (!startShare) return null;
  return (
    <IconButton
      size={size}
      label={t("message.share")}
      icon={<Share2 />}
      onClick={() => startShare(messageId, turn)}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    />
  );
}

import { createContext, useContext } from "react";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/**
 * Starts the chat's share mode with the turn of one message selected. The
 * live chat provides it; a shared chat and a read-only viewer leave it null,
 * so they show no Share.
 */
export const MessageSharingContext = createContext<((messageId: string) => void) | null>(null);

/**
 * Share on a message: a shortcut into the chat's share mode, with this
 * message's turn already selected. The link is made, copied and revoked in
 * the share bar, as for any chat share.
 */
export function ShareMessageButton({
  messageId,
  size = "sm",
  className,
}: {
  messageId: string;
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
      onClick={() => startShare(messageId)}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    />
  );
}

import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";

// Under-message copy affordance: copies the turn's raw text (the markdown
// source, not the rendered HTML). Swaps to a check for a beat as feedback.
export function CopyMessageButton({
  text,
  size = "sm",
  className,
}: {
  text: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const { copiedText, copy } = useCopyFeedback();
  const copied = copiedText !== null;

  return (
    <IconButton
      size={size}
      label={copied ? t("message.copied", "Copied") : t("message.copy", "Copy message")}
      icon={copied ? <Check /> : <Copy />}
      onClick={() => void copy(text)}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    />
  );
}

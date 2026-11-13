import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * A faint centered line where the chat's agent session was renewed, with the
 * reason, so the guardian can see how often it happens. A reason this build
 * does not know shows as it came. It is text only: it opens nothing.
 */
export function SessionRenewalNotice({
  reason,
  className,
}: {
  reason: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const text = t("sessionRenewal.notice", {
    reason: t(`sessionRenewal.reasons.${reason}`, { defaultValue: reason }),
  });
  return (
    <p
      role="note"
      data-session-renewal={reason}
      className={cn("mb-4 text-center text-aux text-muted-foreground opacity-70", className)}
    >
      {text}
    </p>
  );
}

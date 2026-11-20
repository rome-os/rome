import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderFailureResolution, ProviderOutagePart } from "@rome/api-types/chat";
import { useProviderName } from "@/components/default-provider";
import { ChatNotice } from "@/components/chat/ChatNotice";
import {
  FailureActions,
  failureText,
  resolvedText,
} from "@/components/chat/entries/ProviderFailureCard";
import { TaskLink } from "@/components/chat/task-link/TaskLink";
import {
  type ProviderSwitch,
  useProviderOutages,
  useSwitchOutage,
} from "@/hooks/use-default-provider";
import { cn } from "@/lib/utils";

/**
 * The Concierge main chat's notice for unattended chats (task chats, routines)
 * one provider failure stopped: what stopped, the task links, and the same
 * buttons as a failure card, which act on every chat at once. The open
 * outages are read live, so a notice the server has not rewritten yet still
 * reads as settled once its outage is gone.
 */
export function ProviderOutageNotice({
  part,
  className,
}: {
  part: ProviderOutagePart;
  className?: string;
}) {
  const { t, i18n } = useTranslation("chat");
  const providerName = useProviderName();
  const outages = useProviderOutages();
  const switchOutage = useSwitchOutage();
  const [switched, setSwitched] = useState<ProviderFailureResolution | null>(null);
  const live = outages.data?.find((outage) => outage.id === part.outageId);
  const resolved: ProviderFailureResolution | null =
    part.resolved ??
    switched ??
    (part.resolvedAt || (outages.isSuccess && !live)
      ? { at: part.resolvedAt ?? "", by: "recovered" }
      : null);

  if (resolved) {
    return (
      <ChatNotice className={cn("mb-4", className)}>
        {resolvedText({ ...resolved, continued: false }, t, providerName)}
      </ChatNotice>
    );
  }

  const facts = {
    ...part,
    reason: live?.reason ?? part.reason,
    until: live?.until ?? part.until,
  };
  const chatIds = live?.chatIds ?? part.chatIds;
  const onSwitch = (change: ProviderSwitch) =>
    switchOutage.mutate(
      { outageId: part.outageId, change },
      {
        onSuccess: () =>
          setSwitched({
            at: new Date().toISOString(),
            by: "switched",
            ...(change.kind === "provider"
              ? { provider: change.provider }
              : { model: part.replacement?.model }),
          }),
      },
    );

  return (
    <div role="note" data-provider-outage="" className={cn("mb-4 text-center", className)}>
      <p className="text-aux text-muted-foreground">
        {failureText(facts, t, providerName, i18n.language)}
      </p>
      <p className="mt-1 text-aux text-muted-foreground">
        {t("providerOutage.waiting", { count: chatIds.length })}
      </p>
      {chatIds.length > 0 && (
        <ul className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-aux">
          {chatIds.map((chatId) => (
            <li key={chatId}>
              <TaskLink id={chatId} />
            </li>
          ))}
        </ul>
      )}
      <FailureActions
        facts={facts}
        affectedTasks={part.chatIds.length}
        pending={switchOutage.isPending}
        failed={switchOutage.isError}
        onSwitch={onSwitch}
        centered
      />
    </div>
  );
}

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getQuotaSwitchTarget, switchChatQuotaProvider } from "@/lib/chat-api";
import type { ChatSession } from "@/lib/chat-types";

export function QuotaSwitchCard({
  sessionId,
  onSwitched,
  onRefused,
}: {
  sessionId: string;
  onSwitched: (session: ChatSession) => Promise<void>;
  onRefused: () => void;
}) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  const queryKey = ["quota-switch", sessionId];
  const { data: target } = useQuery({
    queryKey,
    queryFn: () => getQuotaSwitchTarget(sessionId),
    staleTime: 0,
    retry: false,
  });
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  if (!target) return null;

  const switchProvider = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    let session: ChatSession;
    try {
      session = await switchChatQuotaProvider(sessionId);
    } catch {
      queryClient.setQueryData(queryKey, null);
      onRefused();
      return;
    }
    queryClient.setQueryData(queryKey, null);
    void queryClient.invalidateQueries({ queryKey });
    // A failed send uses the chat's existing error path, not a second switch.
    await onSwitched(session).catch(() => {});
  };

  return (
    <div
      role="status"
      className="mb-2 min-w-0 rounded-16 border border-border bg-surface p-3 text-ui"
    >
      <p className="mb-2 text-muted-foreground">
        {t("quotaSwitch.description", {
          from: target.provider === "openai" ? "Claude" : "Codex",
          to: target.provider === "openai" ? "Codex" : "Claude",
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 w-full whitespace-normal py-2"
        disabled={pending}
        onClick={() => void switchProvider()}
      >
        {t(target.provider === "openai" ? "quotaSwitch.toCodex" : "quotaSwitch.toClaude")}
      </Button>
    </div>
  );
}

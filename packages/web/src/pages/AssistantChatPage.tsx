import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { CircleAlert, SendHorizontal } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@rome/api-types/message";
import type { TimelinePage } from "@rome/api-types/people";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { randomUUID } from "@/lib/random-uuid";
import { listAssistants, readAssistantMessages, sendToAssistant } from "@/lib/assistants-api";
import { PAGE_FLOOR, PageHeader, PageShell } from "@/shell/PageShell";
import { useAssistantKindLabel } from "@/shell/AssistantChats";
import { useDocumentTitle } from "@/hooks/use-document-title";

/** How often the open chat is read again, so an assistant's message and main's
 *  answer appear without a reload. */
const POLL_MS = 5_000;

const ASSISTANTS_KEY = "assistants";
const MESSAGES_KEY = "assistant-messages";

/**
 * One assistant's chat (docs/domains/chats.md#assistant): what the assistant
 * and Rome said, oldest first, and a box that writes to the assistant. What the
 * guardian writes wakes no agent; main answers the assistant's messages, and
 * those answers show here as Rome's.
 */
export function AssistantChatPage() {
  const { agentId = "" } = useParams<{ agentId: string }>();
  const { t } = useTranslation("common");
  const kindLabel = useAssistantKindLabel();
  const queryClient = useQueryClient();

  const assistants = useQuery({
    queryKey: [ASSISTANTS_KEY],
    queryFn: ({ signal }) => listAssistants(signal),
  });
  const assistant = assistants.data?.find((candidate) => candidate.agentId === agentId);

  const timeline = useInfiniteQuery<TimelinePage>({
    queryKey: [MESSAGES_KEY, agentId],
    enabled: agentId !== "",
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: ({ signal, pageParam }) =>
      readAssistantMessages(agentId, pageParam as string | null, signal),
    refetchInterval: POLL_MS,
  });
  // Pages arrive newest first; a chat reads top-down, oldest first.
  const entries = [...(timeline.data?.pages.flatMap((page) => page.entries) ?? [])].reverse();

  const [sendError, setSendError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (text: string) => sendToAssistant(agentId, text, randomUUID()),
    onSuccess: (row) => {
      setSendError(row.state === "failed" ? (row.error ?? t("assistantChat.sendFailed")) : null);
      void queryClient.invalidateQueries({ queryKey: [MESSAGES_KEY, agentId] });
      void queryClient.invalidateQueries({ queryKey: [ASSISTANTS_KEY] });
    },
    onError: (error) => setSendError(error.message),
  });

  const name = assistant?.name ?? t("assistants.unknownName");
  useDocumentTitle(assistant ? [assistant.name, t("assistants.title")] : null);

  return (
    <PageShell className="flex min-h-full flex-col">
      <PageHeader
        title={name}
        titleAside={
          assistant ? <Badge variant="muted">{kindLabel(assistant.kind)}</Badge> : undefined
        }
        description={
          assistant && !assistant.sameAccount
            ? t("assistantChat.otherAccount", { account: assistant.account, name })
            : t("assistantChat.description", { name })
        }
      />

      <div className="mt-6 flex flex-1 flex-col">
        {timeline.hasNextPage && (
          <div className="flex justify-center pb-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={timeline.isFetchingNextPage}
              onClick={() => void timeline.fetchNextPage()}
            >
              {t("assistantChat.loadOlder")}
            </Button>
          </div>
        )}

        {timeline.isPending ? (
          <p className="py-8 text-center text-aux text-muted-foreground">
            {t("assistantChat.loading")}
          </p>
        ) : timeline.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{timeline.error.message}</AlertDescription>
          </Alert>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-aux text-subtle-foreground">
            {t("assistantChat.empty", { name })}
          </p>
        ) : (
          <ol className="space-y-3" aria-label={t("assistantChat.messagesLabel", { name })}>
            {entries.map((entry) => (
              <ChatLine key={`${entry.source}:${entry.ref}`} entry={entry} assistantName={name} />
            ))}
          </ol>
        )}

        <Composer
          name={name}
          sending={send.isPending}
          error={sendError}
          onSend={(text) => {
            setSendError(null);
            send.mutate(text);
          }}
        />
      </div>
    </PageShell>
  );
}

function ChatLine({ entry, assistantName }: { entry: Message; assistantName: string }) {
  const { t, i18n } = useTranslation("common");
  const outbound = entry.direction === "outbound";
  const who = outbound ? t("assistantChat.rome") : (entry.sender?.name ?? assistantName);
  const time = new Date(entry.timestamp * 1000).toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-12 border px-3 py-2 ${
          outbound ? "border-border-subtle bg-surface-hover" : "border-border bg-surface"
        }`}
      >
        <p className="mb-1 text-badge text-subtle-foreground">
          <span>{who}</span>
          <span className="font-mono tabular-nums"> · {time}</span>
        </p>
        <p className="whitespace-pre-wrap break-words text-ui text-foreground">
          {entry.body ?? t("assistantChat.noText")}
        </p>
      </div>
    </li>
  );
}

function Composer({
  name,
  sending,
  error,
  onSend,
}: {
  name: string;
  sending: boolean;
  error: string | null;
  onSend: (text: string) => void;
}) {
  const { t } = useTranslation("common");
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");

  function submit() {
    const text = draftRef.current.trim();
    if (text === "" || sending) return;
    // Cleared at once so a second Enter cannot send the same draft again.
    draftRef.current = "";
    setDraft("");
    onSend(text);
  }

  return (
    <div className={`pointer-events-none sticky bottom-0 z-10 mt-auto pt-4 ${PAGE_FLOOR}`}>
      <div className="pointer-events-auto rounded-16 border border-border bg-surface/95 p-3 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80">
        {error ? (
          <p role="alert" className="mb-2 text-aux text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            value={draft}
            onChange={(event) => {
              draftRef.current = event.target.value;
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t("assistantChat.placeholder", { name })}
            aria-label={t("assistantChat.composerLabel", { name })}
          />
          <Button
            type="button"
            size="sm"
            disabled={draft.trim() === "" || sending}
            onClick={submit}
          >
            <SendHorizontal data-icon="inline-start" aria-hidden="true" />
            {t("assistantChat.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AssistantChatPage;

import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Bot, Check, ChevronDown, CircleAlert } from "lucide-react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Assistant } from "@rome/api-types/assistants";
import type { Message } from "@rome/api-types/message";
import type { TimelinePage } from "@rome/api-types/people";
import { AssistantKindMark, useAssistantKindLabel } from "@/components/assistant-kind-icon";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { ChatComposer } from "@/components/chat/ChatComposer";
import Markdown from "@/components/chat/ChatMarkdown";
import { MessageRow } from "@/components/chat/MessageRow";
import { TextBlock } from "@/components/chat/entries/TextBlock";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import {
  ASSISTANT_PARAM,
  discardAssistantSend,
  listAssistants,
  readAssistantMessages,
  sendToAssistant,
} from "@/lib/assistants-api";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { randomUUID } from "@/lib/random-uuid";

/** How often the open chat is read again, so an assistant's message and main's
 *  answer appear without a reload. */
const POLL_MS = 5_000;

/** How often the list of assistants is read again. */
const LIST_POLL_MS = 30_000;

const ASSISTANTS_KEY = "assistants";
const MESSAGES_KEY = "assistant-messages";

/**
 * The assistants (docs/domains/chats.md#assistant), one chat at a time. It
 * opens on the chat that moved last, and the header switches to another. The
 * page stays off the sidebar until the guardian adds it: main answers
 * assistants, so the guardian reads these chats now and then rather than
 * watching them.
 */
export function AssistantsPage() {
  const { t } = useTranslation("common");
  const [params, setParams] = useSearchParams();
  const assistants = useQuery({
    queryKey: [ASSISTANTS_KEY],
    queryFn: ({ signal }) => listAssistants(signal),
    // Keeps the switcher's last-message times and order current while a
    // chat is open.
    refetchInterval: LIST_POLL_MS,
  });
  // The list comes newest chat first, so with no choice made the page opens on
  // the chat that moved last.
  const chosen = params.get(ASSISTANT_PARAM);
  const assistant =
    assistants.data?.find((candidate) => candidate.agentId === chosen) ?? assistants.data?.[0];
  useDocumentTitle(assistant ? [assistant.name, t("assistants.title")] : t("assistants.title"));

  return (
    <div className="flex h-[var(--rome-mobile-content-height)] min-h-0 flex-col overflow-hidden md:h-[var(--rome-viewport-height)]">
      <div className="@container/chat relative flex h-full overflow-hidden bg-chat-canvas [--background:var(--chat-canvas)]">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {assistants.isPending ? (
            <div className="space-y-2 p-4" aria-hidden>
              <Skeleton className="h-8 w-48" />
            </div>
          ) : assistants.error && !assistants.data ? (
            <div className="p-4">
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{t("assistants.loadFailed")}</AlertDescription>
              </Alert>
            </div>
          ) : !assistant ? (
            <div className="flex flex-1 items-center justify-center p-4">
              <EmptyState className="max-w-md">
                <EmptyStateIcon>
                  <Bot aria-hidden />
                </EmptyStateIcon>
                <EmptyStateTitle>{t("assistants.empty.title")}</EmptyStateTitle>
                <p className="text-ui text-muted-foreground">{t("assistants.empty.body")}</p>
              </EmptyState>
            </div>
          ) : (
            <AssistantChat
              // A fresh chat per assistant, so a draft or an error never
              // carries over to the next one.
              key={assistant.agentId}
              assistant={assistant}
              assistants={assistants.data}
              onSwitch={(agentId) => setParams({ [ASSISTANT_PARAM]: agentId })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One assistant's chat, drawn with the chat page's own parts: its header,
 * transcript column, bubbles and composer. The assistant speaks on the left
 * like an agent; Rome's lines, the guardian's and main's answers alike, sit on
 * the right. The composer takes text only and writes to the assistant, which
 * wakes no agent.
 */
function AssistantChat({
  assistant,
  assistants,
  onSwitch,
}: {
  assistant: Assistant;
  assistants: readonly Assistant[];
  onSwitch: (agentId: string) => void;
}) {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const { scrollRef, contentRef } = useStickToBottom();
  const { agentId, name } = assistant;
  const mark = <AssistantKindMark kind={assistant.kind} className="h-1/2 w-1/2" />;

  const timeline = useInfiniteQuery<TimelinePage>({
    queryKey: [MESSAGES_KEY, agentId],
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: ({ signal, pageParam }) =>
      readAssistantMessages(agentId, pageParam as string | null, signal),
    refetchInterval: POLL_MS,
  });
  // Pages arrive newest first; a chat reads top-down, oldest first.
  const entries = [...(timeline.data?.pages.flatMap((page) => page.entries) ?? [])].reverse();

  const [sendError, setSendError] = useState<string | null>(null);

  return (
    <>
      <div className="z-20 flex h-12 shrink-0 items-center gap-1 border-b border-border bg-chat-canvas/80 pl-2 pr-2 backdrop-blur-md supports-[backdrop-filter]:bg-chat-canvas/65">
        <AssistantSwitcher assistant={assistant} assistants={assistants} onSwitch={onSwitch} />
      </div>

      <div
        ref={scrollRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
      >
        <div className="flex-1">
          <div ref={contentRef} className="mx-auto max-w-5xl px-4 pt-4 md:px-6">
            {timeline.hasNextPage && (
              <div className="mb-4 flex justify-center">
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
            <p className="mb-6 text-center text-aux text-subtle-foreground">
              {assistant.sameAccount
                ? t("assistantChat.description", { name })
                : t("assistantChat.otherAccount", { account: assistant.account, name })}
            </p>
            {timeline.isPending ? (
              <p className="py-8 text-center text-aux text-muted-foreground">
                {t("assistantChat.loading")}
              </p>
            ) : timeline.error ? (
              <p role="alert" className="py-8 text-center text-aux text-destructive">
                {timeline.error.message}
              </p>
            ) : entries.length === 0 ? (
              <p className="py-8 text-center text-aux text-subtle-foreground">
                {t("assistantChat.empty", { name })}
              </p>
            ) : (
              entries.map((entry) => (
                <ChatLine
                  key={`${entry.source}:${entry.ref}`}
                  entry={entry}
                  name={name}
                  mark={mark}
                />
              ))
            )}
          </div>
        </div>

        <div className="pointer-events-none sticky bottom-0 z-10 px-3 pb-[calc(var(--rome-safe-area-bottom)+1rem)] md:px-6 md:pb-[calc(var(--rome-safe-area-bottom)+1.5rem)]">
          <div className="pointer-events-auto mx-auto max-w-5xl">
            <ChatComposer
              textOnly
              lockAgentMention
              placeholder={t("assistantChat.placeholder", { name })}
              streamError={sendError}
              boxClassName="rounded-16 border border-border bg-surface/95 p-4 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
              onSend={async (snapshot) => {
                setSendError(null);
                try {
                  const row = await sendToAssistant(agentId, snapshot.text, randomUUID());
                  if (row.state === "failed") {
                    // A failed row answers its id forever, so it is discarded
                    // and the guardian's retry goes out as a new message.
                    void discardAssistantSend(agentId, row.id).catch(() => {});
                    throw new Error(row.error ?? t("assistantChat.sendFailed"));
                  }
                } catch (error) {
                  setSendError(error instanceof Error ? error.message : String(error));
                  // Rejecting gives the draft back to the composer.
                  throw error;
                } finally {
                  void queryClient.invalidateQueries({ queryKey: [MESSAGES_KEY, agentId] });
                  void queryClient.invalidateQueries({ queryKey: [ASSISTANTS_KEY] });
                }
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** The header's assistant, which opens the list of the others to switch to. */
function AssistantSwitcher({
  assistant,
  assistants,
  onSwitch,
}: {
  assistant: Assistant;
  assistants: readonly Assistant[];
  onSwitch: (agentId: string) => void;
}) {
  const { t } = useTranslation("common");
  const kindLabel = useAssistantKindLabel();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 gap-2 px-2"
          aria-label={t("assistants.switch", { name: assistant.name })}
        >
          <AgentAvatar
            label={assistant.name}
            size="sm"
            mark={<AssistantKindMark kind={assistant.kind} className="h-1/2 w-1/2" />}
            className="shrink-0"
          />
          <span className="truncate text-ui text-foreground">{assistant.name}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        {assistants.map((option) => (
          <DropdownMenuItem key={option.agentId} onSelect={() => onSwitch(option.agentId)}>
            <AssistantKindMark kind={option.kind} className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            <span className="sr-only">{kindLabel(option.kind)}</span>
            <span className="shrink-0 text-aux text-subtle-foreground">
              {option.lastMessageAt === null
                ? t("assistants.noMessages")
                : formatMessageTimestamp(new Date(option.lastMessageAt * 1000).toISOString())}
            </span>
            {option.agentId === assistant.agentId ? (
              <Check className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
            ) : (
              <span className="size-3.5 shrink-0" aria-hidden />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A line Rome said sits on the right like the guardian's own message; the
 *  assistant's sits on the left under its name, like an agent's. */
function ChatLine({ entry, name, mark }: { entry: Message; name: string; mark: ReactNode }) {
  const { t } = useTranslation("common");
  const body = entry.body ?? t("assistantChat.noText");
  const time = formatMessageTimestamp(new Date(entry.timestamp * 1000).toISOString());
  if (entry.direction === "outbound") {
    return (
      <div className="mb-4 flex flex-col items-end">
        <ChatBubble tone="sent" className="max-w-[70%]" title={time}>
          <Markdown>{body}</Markdown>
        </ChatBubble>
      </div>
    );
  }
  const sender = entry.sender?.name ?? name;
  return (
    <MessageRow
      avatar={<AgentAvatar label={sender} mark={mark} />}
      name={sender}
      subtitle={<span className="text-aux text-subtle-foreground">{time}</span>}
    >
      <ChatBubble tone="received">
        <TextBlock content={body} />
      </ChatBubble>
    </MessageRow>
  );
}

export default AssistantsPage;

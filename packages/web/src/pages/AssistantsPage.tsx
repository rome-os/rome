import { type ReactNode, useEffect, useMemo, useState } from "react";
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
  listAssistants,
  readAssistantMessages,
  sendToAssistant,
} from "@/lib/assistants-api";
import { formatMessageTimestamp } from "@/lib/message-timestamp";

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
  // the chat that moved last. A choice that names nobody listed opens nothing
  // else: a link must never put the guardian in another assistant's chat.
  const chosen = params.get(ASSISTANT_PARAM);
  const assistant =
    chosen === null
      ? assistants.data?.[0]
      : assistants.data?.find((candidate) => candidate.agentId === chosen);
  useDocumentTitle(assistant ? [assistant.name, t("assistants.title")] : t("assistants.title"));
  // The chat the page opened on is written into the address, so a list that
  // refreshes into a new order never moves the open chat, and its draft, away
  // from the guardian. Replaces rather than pushes: it is the same view.
  useEffect(() => {
    if (chosen === null && assistant) {
      setParams({ [ASSISTANT_PARAM]: assistant.agentId }, { replace: true });
    }
  }, [assistant, chosen, setParams]);

  return (
    <div className="flex h-[var(--rome-mobile-content-height)] min-h-0 flex-col overflow-hidden md:h-[var(--rome-viewport-height)]">
      <div className="@container/chat relative flex h-full overflow-hidden bg-chat-canvas [--background:var(--chat-canvas)]">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {assistants.isPending ? (
            <div className="space-y-2 p-4" aria-hidden>
              <Skeleton className="h-8 w-48" />
            </div>
          ) : assistants.error && !assistants.data?.length ? (
            <div className="p-4">
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{t("assistants.loadFailed")}</AlertDescription>
              </Alert>
            </div>
          ) : !assistant && chosen !== null && assistants.data.length > 0 ? (
            <div className="flex flex-1 items-center justify-center p-4">
              <EmptyState className="max-w-md">
                <EmptyStateIcon>
                  <Bot aria-hidden />
                </EmptyStateIcon>
                <EmptyStateTitle>{t("assistants.notFound.title")}</EmptyStateTitle>
                <p className="text-ui text-muted-foreground">{t("assistants.notFound.body")}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setParams({})}>
                  {t("assistants.notFound.openLatest")}
                </Button>
              </EmptyState>
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

  // The newest page polls on its own; older history is read once, from where
  // the newest page ended when the guardian asked for it. Polling the pages
  // together would re-read all of history on every tick.
  const latest = useQuery<TimelinePage>({
    queryKey: [MESSAGES_KEY, agentId, "latest"],
    queryFn: ({ signal }) => readAssistantMessages(agentId, null, signal),
    refetchInterval: POLL_MS,
  });
  const [olderFrom, setOlderFrom] = useState<string | null>(null);
  const older = useInfiniteQuery<TimelinePage>({
    queryKey: [MESSAGES_KEY, agentId, "older", olderFrom],
    enabled: olderFrom !== null,
    initialPageParam: olderFrom,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: ({ signal, pageParam }) => readAssistantMessages(agentId, pageParam as string, signal),
  });
  // A failed first read of older history has no page to go on from, so the
  // control stays and reads the same place again.
  const olderFailedFirst = older.isError && !older.data;
  const hasOlder =
    olderFrom === null ? Boolean(latest.data?.nextCursor) : older.hasNextPage || olderFailedFirst;
  const loadOlder = () => {
    if (olderFrom === null) setOlderFrom(latest.data?.nextCursor ?? null);
    else if (olderFailedFirst) void older.refetch();
    else void older.fetchNextPage();
  };
  // Every message the newest page has returned stays on screen. The page is a
  // fixed size, so a new message pushes its oldest one out, and older history
  // began where the page ended when the guardian asked for it: without this,
  // the messages pushed out in between would be in neither read.
  const [kept, setKept] = useState<readonly Message[]>([]);
  useEffect(() => {
    if (latest.data) setKept((previous) => newestFirst([...latest.data.entries, ...previous]));
  }, [latest.data]);
  // A chat reads top-down, oldest first.
  const entries = useMemo(
    () =>
      newestFirst([
        ...(latest.data?.entries ?? []),
        ...kept,
        ...(older.data?.pages.flatMap((page) => page.entries) ?? []),
      ]).reverse(),
    [latest.data, kept, older.data],
  );

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
            {hasOlder && (
              <div className="mb-4 flex flex-col items-center gap-2">
                {older.isError ? (
                  <p role="alert" className="text-aux text-destructive">
                    {t("assistantChat.loadOlderFailed")}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={older.isFetching}
                  onClick={loadOlder}
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
            {latest.isPending ? (
              <p className="py-8 text-center text-aux text-muted-foreground">
                {t("assistantChat.loading")}
              </p>
            ) : latest.error && !latest.data ? (
              <p role="alert" className="py-8 text-center text-aux text-destructive">
                {latest.error.message}
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

        {/* Below md the floor paints the canvas and takes pointer events. Its
            side gutters and bottom padding sit outside the box's blur, and on a
            phone a transparent strip there shows the transcript beside and
            below the box, and lets a tap land on a link it hides. From md up
            it stays transparent, so messages scroll visibly under the box. */}
        <div
          data-chat-floor
          className="pointer-events-none sticky bottom-0 z-10 px-3 pb-[calc(var(--rome-safe-area-bottom)+1rem)] max-md:pointer-events-auto max-md:bg-chat-canvas md:px-6 md:pb-[calc(var(--rome-safe-area-bottom)+1.5rem)]"
        >
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
                  await sendToAssistant(agentId, snapshot.text);
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
  // The assistant's name as listed now. The channel froze a label with its
  // kind ("Research dot (dot)") into each message, which the header and the
  // mark already say.
  return (
    <MessageRow
      avatar={<AgentAvatar label={name} mark={mark} />}
      name={name}
      subtitle={<span className="text-aux text-subtle-foreground">{time}</span>}
    >
      <ChatBubble tone="received">
        <TextBlock content={body} />
      </ChatBubble>
    </MessageRow>
  );
}

/** Each message once, newest first. The reads overlap, and a message read
 *  twice keeps its first copy. */
function newestFirst(messages: readonly Message[]): Message[] {
  const seen = new Set<string>();
  return messages
    .filter((message) => {
      const key = `${message.source}:${message.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}

export default AssistantsPage;

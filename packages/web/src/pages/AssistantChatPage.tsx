import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@rome/api-types/message";
import type { TimelinePage } from "@rome/api-types/people";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { ChatComposer } from "@/components/chat/ChatComposer";
import Markdown from "@/components/chat/ChatMarkdown";
import { MessageRow } from "@/components/chat/MessageRow";
import { TextBlock } from "@/components/chat/entries/TextBlock";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { listAssistants, readAssistantMessages, sendToAssistant } from "@/lib/assistants-api";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { randomUUID } from "@/lib/random-uuid";
import { AssistantKindMark, useAssistantKindLabel } from "@/components/assistant-kind-icon";

/** How often the open chat is read again, so an assistant's message and main's
 *  answer appear without a reload. */
const POLL_MS = 5_000;

const ASSISTANTS_KEY = "assistants";
const MESSAGES_KEY = "assistant-messages";

/**
 * One assistant's chat (docs/domains/chats.md#assistant), drawn with the chat
 * page's own parts: its header, transcript column, bubbles and composer. The
 * assistant speaks on the left like an agent; Rome's lines, the guardian's and
 * main's answers alike, sit on the right. The composer takes text only and
 * writes to the assistant, which wakes no agent; main answers the assistant's
 * messages.
 */
export function AssistantChatPage() {
  const { agentId = "" } = useParams<{ agentId: string }>();
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const kindLabel = useAssistantKindLabel();
  const { scrollRef, contentRef } = useStickToBottom();

  const assistants = useQuery({
    queryKey: [ASSISTANTS_KEY],
    queryFn: ({ signal }) => listAssistants(signal),
  });
  const assistant = assistants.data?.find((candidate) => candidate.agentId === agentId);
  const name = assistant?.name ?? t("assistants.unknownName");
  const mark = assistant ? (
    <AssistantKindMark kind={assistant.kind} className="h-1/2 w-1/2" />
  ) : undefined;
  useDocumentTitle(assistant ? [assistant.name, t("assistants.title")] : null);

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

  return (
    <div className="flex h-[var(--rome-mobile-content-height)] min-h-0 flex-col overflow-hidden md:h-[var(--rome-viewport-height)]">
      <div className="@container/chat relative flex h-full overflow-hidden bg-chat-canvas [--background:var(--chat-canvas)]">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="z-20 flex h-12 shrink-0 items-center gap-1 border-b border-border bg-chat-canvas/80 pl-4 pr-2 backdrop-blur-md supports-[backdrop-filter]:bg-chat-canvas/65 max-md:hidden">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <AgentAvatar label={name} size="sm" mark={mark} className="shrink-0" />
              <span className="truncate text-ui text-foreground">{name}</span>
              {assistant ? <span className="sr-only">{kindLabel(assistant.kind)}</span> : null}
            </div>
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
                  {assistant && !assistant.sameAccount
                    ? t("assistantChat.otherAccount", { account: assistant.account, name })
                    : t("assistantChat.description", { name })}
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
                      // The composer reuses its input id when the same draft
                      // is resent, so a retry is one message, not two.
                      const row = await sendToAssistant(
                        agentId,
                        snapshot.text,
                        snapshot.inputId ?? randomUUID(),
                      );
                      if (row.state === "failed") {
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
        </div>
      </div>
    </div>
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

export default AssistantChatPage;

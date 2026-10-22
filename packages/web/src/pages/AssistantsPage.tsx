import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Bot, CircleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AssistantKindIcon, useAssistantKindLabel } from "@/components/assistant-kind-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { assistantPath, listAssistants } from "@/lib/assistants-api";
import { formatMessageTimestamp } from "@/lib/message-timestamp";
import { PageBody, PageHeader, PageShell } from "@/shell/PageShell";

/**
 * Every assistant Rome Cloud lists for this Rome (docs/domains/chats.md#assistant),
 * newest chat first, each opening its chat. A page of its own rather than a
 * group in the chat list: main answers assistants, so the guardian reads their
 * chats now and then and pins this page to the sidebar if they want it close.
 */
export function AssistantsPage() {
  const { t } = useTranslation("common");
  const kindLabel = useAssistantKindLabel();
  const assistants = useQuery({
    queryKey: ["assistants"],
    queryFn: ({ signal }) => listAssistants(signal),
  });

  return (
    <PageShell>
      <PageBody>
        <PageHeader title={t("assistants.title")} />
        {assistants.isPending ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : assistants.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{t("assistants.loadFailed")}</AlertDescription>
          </Alert>
        ) : assistants.data.length === 0 ? (
          <EmptyState className="rounded-8 border border-dashed border-border bg-surface/50">
            <EmptyStateIcon>
              <Bot aria-hidden />
            </EmptyStateIcon>
            <EmptyStateTitle>{t("assistants.empty.title")}</EmptyStateTitle>
            <p className="text-ui text-muted-foreground">{t("assistants.empty.body")}</p>
          </EmptyState>
        ) : (
          <List asChild className="rounded-8 border border-border bg-surface">
            <ul>
              {assistants.data.map((assistant) => (
                <li key={assistant.agentId}>
                  <ListRow asChild interactive>
                    <Link to={assistantPath(assistant.agentId)}>
                      <AssistantKindIcon kind={assistant.kind} className="size-4" />
                      <ListRowContent>
                        <ListRowTitle className="truncate">{assistant.name}</ListRowTitle>
                        <ListRowDescription className="truncate">
                          {assistant.sameAccount
                            ? kindLabel(assistant.kind)
                            : `${kindLabel(assistant.kind)} · @${assistant.account}`}
                        </ListRowDescription>
                      </ListRowContent>
                      <span className="shrink-0 text-aux text-subtle-foreground">
                        {assistant.lastMessageAt === null
                          ? t("assistants.noMessages")
                          : formatMessageTimestamp(
                              new Date(assistant.lastMessageAt * 1000).toISOString(),
                            )}
                      </span>
                    </Link>
                  </ListRow>
                </li>
              ))}
            </ul>
          </List>
        )}
      </PageBody>
    </PageShell>
  );
}

export default AssistantsPage;

import { useQuery } from "@tanstack/react-query";
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Markdown from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTaskTime } from "@/components/concierge/tasks";
import { cn } from "@/lib/utils";
import { type ChatOutput, useChatOutputs } from "./chat-outputs";

/** The most text a preview shows, so a large log cannot stall the tab. */
export const PREVIEW_CHARS = 200_000;

type Preview = "image" | "markdown" | "text" | "file";

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|sql|x-sh))/;
const CODE_EXTENSIONS =
  /\.(c|cc|cpp|cs|css|go|h|java|js|jsx|json|kt|mjs|py|rb|rs|sh|sql|swift|toml|ts|tsx|xml|ya?ml)$/i;

/** How the tab previews an output: never as a page that runs. */
export function previewOf(output: Pick<ChatOutput, "name" | "mimeType">): Preview {
  const type = output.mimeType ?? "";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type === "text/markdown" || /\.(md|markdown)$/i.test(output.name)) return "markdown";
  if (TEXT_TYPES.test(type) && type !== "text/html") return "text";
  return "file";
}

function OutputIcon({ output, className }: { output: ChatOutput; className?: string }) {
  const type = output.mimeType ?? "";
  const props = {
    className: cn("size-4 shrink-0 text-muted-foreground", className),
    "aria-hidden": true,
  };
  if (type.startsWith("image/")) return <FileImage {...props} />;
  if (type.startsWith("video/")) return <FileVideo {...props} />;
  if (type.startsWith("audio/")) return <FileAudio {...props} />;
  if (/zip|tar|gzip|compressed/.test(type)) return <FileArchive {...props} />;
  if (/csv|spreadsheet|excel/.test(type)) return <FileSpreadsheet {...props} />;
  if (CODE_EXTENSIONS.test(output.name)) return <FileCode {...props} />;
  if (type.startsWith("text/") || type === "application/pdf") return <FileText {...props} />;
  return <FileIcon {...props} />;
}

interface OutputsPanelProps {
  chatId: string;
  /** The output to preview first, as the tab was opened on it. */
  selectedId?: string | null;
  /** Changes each time the tab is opened on an output, so the same one is chosen again. */
  selectionSeq?: number;
  /** Leaves the panel, as opening a task chat does from a sheet. */
  onNavigate?: () => void;
}

/**
 * A chat's outputs, newest first, with a preview of the chosen one under the
 * list. docs/domains/chats.md#outputs
 */
export function OutputsPanel({
  chatId,
  selectedId = null,
  selectionSeq = 0,
  onNavigate,
}: OutputsPanelProps) {
  const { t, i18n } = useTranslation("chat");
  const outputs = useChatOutputs(chatId);
  const [chosen, setChosen] = useState<string | null>(selectedId);
  // A link opened on another output chooses that one.
  useEffect(() => setChosen(selectedId), [selectedId, selectionSeq]);
  const list = outputs.data ?? [];
  // Until one is chosen, the newest is previewed.
  const current = list.find((output) => output.id === chosen) ?? list[0] ?? null;
  const now = Date.now();

  if (outputs.isPending) {
    return (
      <div className="flex flex-col gap-2 p-3" aria-label={t("outputs.loading")} role="status">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  }
  if (outputs.isError) {
    return <p className="p-4 text-ui text-muted-foreground">{t("outputs.loadFailed")}</p>;
  }
  if (list.length === 0) {
    return (
      <EmptyState className="h-full" role="region">
        <EmptyStateIcon>
          <FileOutput />
        </EmptyStateIcon>
        <EmptyStateTitle>{t("outputs.emptyTitle")}</EmptyStateTitle>
        <EmptyStateDescription>{t("outputs.emptyDescription")}</EmptyStateDescription>
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-outputs">
      <List
        asChild
        aria-label={t("outputs.list")}
        className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border"
      >
        <ul>
          {list.map((output) => (
            <li
              key={output.id}
              // The chosen row's fill spans its task chat's chip too.
              className={cn(
                "flex min-w-0 items-center",
                output.id === current?.id && "bg-primary/10",
              )}
            >
              <ListRow asChild interactive selected={output.id === current?.id} className="flex-1">
                <button
                  type="button"
                  aria-current={output.id === current?.id ? "true" : undefined}
                  onClick={() => setChosen(output.id)}
                >
                  <OutputIcon output={output} />
                  <ListRowContent>
                    <ListRowTitle
                      className={cn("truncate", output.missing && "text-muted-foreground")}
                      title={output.path}
                    >
                      {output.name}
                    </ListRowTitle>
                    <ListRowDescription className="truncate">
                      {[
                        output.missing ? t("outputs.missing") : t(`outputs.${output.kind}`),
                        formatTaskTime(Date.parse(output.at), now, i18n.language),
                      ].join(" · ")}
                    </ListRowDescription>
                  </ListRowContent>
                </button>
              </ListRow>
              {output.from && (
                <Badge asChild variant="muted" className="mr-3 max-w-[40%] shrink-0">
                  <Link
                    to={`/chat/${encodeURIComponent(output.from.chatId)}`}
                    onClick={onNavigate}
                    title={t("outputs.from", { name: output.from.name })}
                  >
                    <span className="truncate">
                      {t("outputs.from", { name: output.from.name })}
                    </span>
                  </Link>
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </List>
      <div className="min-h-0 flex-1 overflow-auto pb-safe">
        {current && <OutputPreview key={current.id} output={current} />}
      </div>
    </div>
  );
}

function OutputPreview({ output }: { output: ChatOutput }) {
  const { t } = useTranslation("chat");
  const kind = previewOf(output);
  const url = output.contentUrl;
  const textual = kind === "markdown" || kind === "text";
  const text = useQuery({
    queryKey: ["chat-output-text", url],
    queryFn: async () => {
      const response = await fetch(url ?? "", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load the file");
      return response.text();
    },
    enabled: textual && Boolean(url),
  });

  if (!url) {
    return (
      <p className="p-4 text-ui text-muted-foreground">
        {output.missing ? t("outputs.missing") : t("outputs.unavailable")}
      </p>
    );
  }
  const download = (
    <Button asChild variant="outline" size="sm">
      <a href={url} download={output.name}>
        <Download data-icon="inline-start" />
        {t("outputs.download")}
      </a>
    </Button>
  );
  const header = (
    <div className="flex items-center gap-2 px-4 pt-3">
      <span className="min-w-0 flex-1 truncate text-ui text-foreground" title={output.path}>
        {output.name}
      </span>
      {download}
    </div>
  );

  if (kind === "image") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <img
          src={url}
          alt={output.name}
          className="mx-4 mb-4 max-w-[calc(100%-2rem)] rounded-8 border border-border-subtle"
        />
      </div>
    );
  }
  if (kind === "file") {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="px-4 text-ui text-muted-foreground">{t("outputs.noPreview")}</p>
      </div>
    );
  }
  if (text.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <Skeleton className="mx-4 h-24" />
      </div>
    );
  }
  if (text.isError) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="px-4 text-ui text-muted-foreground">{t("outputs.previewFailed")}</p>
      </div>
    );
  }
  const body = text.data.slice(0, PREVIEW_CHARS);
  const cut = text.data.length > PREVIEW_CHARS;
  return (
    <div className="flex flex-col gap-3 pb-4">
      {header}
      {cut && (
        <p className="px-4 text-aux text-muted-foreground">
          {t("outputs.truncated", { count: PREVIEW_CHARS })}
        </p>
      )}
      {kind === "markdown" ? (
        <div className="px-4" data-testid="output-markdown">
          <Markdown inert>{body}</Markdown>
        </div>
      ) : (
        <pre className="mx-4 overflow-x-auto rounded-8 bg-surface-muted p-3 font-mono text-aux whitespace-pre text-foreground">
          {body}
        </pre>
      )}
    </div>
  );
}

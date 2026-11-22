import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ChevronLeft,
  Download,
  File as FileIcon,
  FileCode,
  FileImage,
  FileOutput,
  FileText,
  Pencil,
  Sheet,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Markdown from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { isPlainClick } from "@/lib/plain-click";
import { cn } from "@/lib/utils";
import { type ChatOutput, useChatOutputs, useTaskChatOutputs } from "./chat-outputs";
import {
  type LeaveGuard,
  OutputEditor,
  leaveEditor,
  outputTextKey,
  useEditablePath,
} from "./OutputEditor";

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

/** What an output is, as the list names it and filters it. */
export type OutputType = "document" | "spreadsheet" | "page" | "image" | "code" | "file";

export function outputTypeOf(output: Pick<ChatOutput, "name" | "mimeType">): OutputType {
  const extension = /\.([a-z0-9]+)$/i.exec(output.name)?.[1]?.toLowerCase() ?? "";
  if (["md", "markdown", "txt", "pdf", "docx", "doc"].includes(extension)) return "document";
  if (["csv", "tsv", "xlsx", "xls"].includes(extension)) return "spreadsheet";
  if (["html", "htm"].includes(extension)) return "page";
  if ((output.mimeType ?? "").startsWith("image/")) return "image";
  if (CODE_EXTENSIONS.test(output.name)) return "code";
  return "file";
}

/** A file name as a title: no extension, words for dashes and underscores, a capital first. */
export function outputTitle(name: string): string {
  const words = name
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!words) return name;
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

const FILTERS = ["all", "document", "spreadsheet", "page"] as const;
type Filter = (typeof FILTERS)[number];

const TYPE_ICON: Record<OutputType, { icon: ReactNode; tint: string }> = {
  document: { icon: <FileText />, tint: "bg-primary/10 text-primary" },
  spreadsheet: { icon: <Sheet />, tint: "bg-success-bg text-success-fg" },
  page: { icon: <AppWindow />, tint: "bg-info-bg text-info-fg" },
  image: { icon: <FileImage />, tint: "bg-brand/15 text-brand" },
  code: { icon: <FileCode />, tint: "bg-surface-muted text-muted-foreground" },
  file: { icon: <FileIcon />, tint: "bg-surface-muted text-muted-foreground" },
};

function TypeIcon({ type }: { type: OutputType }) {
  const { icon, tint } = TYPE_ICON[type];
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-8 [&_svg]:size-4",
        tint,
      )}
    >
      {icon}
    </span>
  );
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** The time today, the date earlier, and the year only when it is not this one. */
function whenLabel(at: Date, now: Date, locale: string): string {
  if (sameDay(at, now)) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
}

interface OutputsPanelProps {
  chatId: string;
  /** The output to open first, as the tab was opened on it. */
  selectedId?: string | null;
  /** Changes each time the tab is opened on an output, so the same one opens again. */
  selectionSeq?: number;
  /** Leaves the panel, as opening a task chat does from a sheet. */
  onNavigate?: () => void;
  /** Opens a task chat beside the chat instead of as its page, as the side pane does. */
  onOpenTaskChat?: (taskChatId: string, name: string) => void;
  /** Whether the panel names itself, where nothing around it does. */
  heading?: boolean;
  /** A Concierge chat: read again when one of its task chats changes, as its turn ends. */
  taskChats?: boolean;
  /**
   * Filled with a check a host runs before it unmounts the panel, as a sheet
   * does on close: it settles a file being edited the way leaving it does and
   * answers whether the host may go on.
   */
  leaveGuard?: LeaveGuard;
}

/**
 * A chat's outputs: a filtered list grouped by day, and one output's preview
 * in its place. docs/domains/chats.md#outputs
 */
export function OutputsPanel({
  chatId,
  selectedId = null,
  selectionSeq = 0,
  onNavigate,
  onOpenTaskChat,
  heading = true,
  taskChats = false,
  leaveGuard,
}: OutputsPanelProps) {
  const { t, i18n } = useTranslation("chat");
  const outputs = useChatOutputs(chatId);
  // A plain press on a task chat's link opens it beside the chat where the
  // host can; any other keeps the link's own meaning, such as a new tab.
  const follow: FollowTaskChat = (event, taskChatId, name) => {
    if (onOpenTaskChat && isPlainClick(event)) {
      event.preventDefault();
      onOpenTaskChat(taskChatId, name);
      return;
    }
    onNavigate?.();
  };
  useTaskChatOutputs(chatId, taskChats);
  const [chosen, setChosen] = useState<string | null>(selectedId);
  const [filter, setFilter] = useState<Filter>("all");
  const ownGuard: LeaveGuard = useRef(null);
  const guard = leaveGuard ?? ownGuard;
  // The file being edited, as it was when Edit was chosen. The edit lives on
  // this, not on the list or the folder's answer: the agent writing the file
  // again swaps its record, and neither may take the editor from under the
  // owner. Only the guarded exits below end it.
  const [editing, setEditing] = useState<{ path: string; output: ChatOutput } | null>(null);
  const list = outputs.data?.outputs ?? [];
  const listRef = useRef(list);
  listRef.current = list;
  // Back to the preview of the file just edited: its record as the list now has
  // it, which is a new one when the file was written again meanwhile.
  const leaveEditing = (then: (output: ChatOutput | null) => void) => {
    const snapshot = editing?.output ?? null;
    const latest = snapshot
      ? (listRef.current.find((output) => output.id === snapshot.id) ??
        listRef.current.find((output) => output.link !== null && output.link === snapshot.link) ??
        null)
      : null;
    leaveEditor(guard, () => {
      setEditing(null);
      then(latest);
    });
  };
  // A link opened on an output opens that one, once a file being edited has
  // settled; if it stays open, so does the file.
  useEffect(
    () =>
      leaveEditor(guard, () => {
        setEditing(null);
        setChosen(selectedId);
      }),
    [guard, selectedId, selectionSeq],
  );
  const indexing = outputs.data?.indexing === true;
  // Earlier outputs still being read back, said quietly where the list is.
  const indexingNote = indexing ? (
    <p role="status" className="px-1 text-aux text-muted-foreground">
      {t("outputs.indexing")}
    </p>
  ) : null;
  const current = list.find((output) => output.id === chosen) ?? null;

  const preview = (output: ChatOutput) => (
    <div className="h-full overflow-y-auto pb-safe" data-testid="chat-outputs">
      <OutputPreview
        key={output.id}
        output={output}
        leaveGuard={guard}
        editingPath={editing?.path ?? null}
        onEdit={(path) => setEditing({ path, output })}
        onDone={() => leaveEditing((latest) => latest && setChosen(latest.id))}
        onBack={() => leaveEditing(() => setChosen(null))}
        onNavigate={follow}
      />
    </div>
  );
  if (editing) return preview(editing.output);

  if (outputs.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-label={t("outputs.loading")} role="status">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (outputs.isError) {
    return <p className="p-4 text-ui text-muted-foreground">{t("outputs.loadFailed")}</p>;
  }
  if (current) return preview(current);
  if (list.length === 0) {
    if (indexing) return <div className="p-4">{indexingNote}</div>;
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

  const now = new Date();
  const shown = list.filter((output) => filter === "all" || outputTypeOf(output) === filter);
  const today = shown.filter((output) => sameDay(new Date(output.at), now));
  const earlier = shown.filter((output) => !sameDay(new Date(output.at), now));
  const group = (key: "today" | "earlier", items: ChatOutput[]) =>
    items.length === 0 ? null : (
      <section key={key} className="flex flex-col gap-2">
        <h3 className="px-1 text-aux text-muted-foreground">{t(`outputs.${key}`)}</h3>
        <ul
          aria-label={t(`outputs.${key}`)}
          className="divide-y divide-border-subtle overflow-hidden rounded-12 border border-border bg-surface"
        >
          {items.map((output) => (
            <OutputRow
              key={output.id}
              output={output}
              when={whenLabel(new Date(output.at), now, i18n.language)}
              onOpen={() => setChosen(output.id)}
              onNavigate={follow}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="h-full overflow-y-auto pb-safe" data-testid="chat-outputs">
      <div className="flex flex-col gap-4 p-4 max-md:px-3">
        {heading && (
          <h2 className="flex items-baseline gap-2 text-title text-foreground">
            {t("outputs.title")}
            <span className="text-ui tabular-nums text-muted-foreground">{list.length}</span>
          </h2>
        )}
        {/* Chips a step tighter than the kit's touch spacing, so the four fit a
            phone's sheet and scroll only in a narrower pane. */}
        <div style={{ "--control-filter-px": "var(--rome-space-3)" } as CSSProperties}>
          <FilterChipGroup<Filter>
            aria-label={t("outputs.filterLabel")}
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((value) => ({ value, label: t(`outputs.filters.${value}`) }))}
          />
        </div>
        {indexingNote}
        {shown.length === 0 ? (
          <p className="px-1 text-ui text-muted-foreground">{t("outputs.noneOfType")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {group("today", today)}
            {group("earlier", earlier)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Follows an output's link to the task chat it came from. */
type FollowTaskChat = (
  event: MouseEvent<HTMLAnchorElement>,
  taskChatId: string,
  name: string,
) => void;

/** Where an output came from, a task chat's link or how this chat's agent made it. */
function SourceText({
  output,
  onNavigate,
  className,
}: {
  output: ChatOutput;
  onNavigate?: FollowTaskChat;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  if (output.missing) return <span className={className}>{t("outputs.missing")}</span>;
  if (!output.from) return <span className={className}>{t(`outputs.${output.kind}`)}</span>;
  const taskChatId = output.from.chatId;
  return (
    <Link
      to={`/chat/${encodeURIComponent(taskChatId)}`}
      onClick={(event) => onNavigate?.(event, taskChatId, output.from?.name ?? "")}
      className={cn(
        "relative z-10 min-w-0 truncate hover:text-foreground hover:underline",
        className,
      )}
    >
      {t("outputs.from", { name: output.from.name })}
    </Link>
  );
}

function OutputRow({
  output,
  when,
  onOpen,
  onNavigate,
}: {
  output: ChatOutput;
  when: string;
  onOpen: () => void;
  onNavigate?: FollowTaskChat;
}) {
  const { t } = useTranslation("chat");
  const type = outputTypeOf(output);
  return (
    <li className="relative flex min-w-0 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover">
      <TypeIcon type={type} />
      <div className="min-w-0 flex-1">
        {/* The whole row opens the output; the task chat's link sits above it. */}
        <button
          type="button"
          onClick={onOpen}
          title={output.name}
          className={cn(
            "block w-full cursor-pointer truncate text-left text-ui outline-none after:absolute after:inset-0 after:rounded-[inherit] after:outline-1 after:-outline-offset-1 after:outline-transparent focus-visible:after:outline-solid focus-visible:after:outline-ring/50",
            output.missing ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {outputTitle(output.name)}
        </button>
        <div className="flex min-w-0 items-center gap-1 text-aux text-muted-foreground">
          <span className="shrink-0">{t(`outputs.types.${type}`)}</span>
          <span aria-hidden>·</span>
          <SourceText output={output} onNavigate={onNavigate} />
        </div>
      </div>
      <span className="shrink-0 text-aux tabular-nums text-muted-foreground">{when}</span>
    </li>
  );
}

/**
 * The first `chars` characters of the file at `url`, read from the stream and
 * then cancelled, so a large file is never downloaded or held whole.
 */
export async function readPrefix(
  url: string,
  chars: number,
): Promise<{ text: string; cut: boolean }> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("Failed to load the file");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length <= chars) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), cut: false };
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return { text: text.slice(0, chars), cut: true };
}

function OutputPreview({
  output,
  leaveGuard,
  editingPath,
  onEdit,
  onDone,
  onBack,
  onNavigate,
}: {
  output: ChatOutput;
  leaveGuard: LeaveGuard;
  /** The project path being edited in place of the preview, or null. */
  editingPath: string | null;
  onEdit: (path: string) => void;
  onDone: () => void;
  onBack: () => void;
  onNavigate?: FollowTaskChat;
}) {
  const { t } = useTranslation("chat");
  const kind = previewOf(output);
  const url = output.contentUrl;
  const textual = kind === "markdown" || kind === "text";
  const editing = editingPath !== null;
  // A text file the agent wrote into the projects folder can be edited in
  // place. Once it is being edited the folder's answer is not asked again.
  const editablePath = useEditablePath(output, textual && output.kind === "written" && !editing);
  const text = useQuery({
    queryKey: outputTextKey(url),
    queryFn: () => readPrefix(url ?? "", PREVIEW_CHARS),
    enabled: textual && Boolean(url) && !editing,
  });

  const download = url ? (
    <Button asChild variant="outline" size="sm">
      <a href={url} download={output.name}>
        <Download data-icon="inline-start" />
        {t("outputs.download")}
      </a>
    </Button>
  ) : null;
  const editToggle =
    editingPath !== null ? (
      <Button variant="outline" size="sm" onClick={onDone}>
        {t("outputs.doneEditing")}
      </Button>
    ) : editablePath !== null ? (
      <IconButton
        size="sm"
        label={t("outputs.edit")}
        icon={<Pencil />}
        onClick={() => onEdit(editablePath)}
      />
    ) : null;
  const header = (
    <div className="flex items-center gap-2 pt-2 pr-4 pl-2">
      <IconButton size="sm" label={t("outputs.back")} icon={<ChevronLeft />} onClick={onBack} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-foreground" title={output.path}>
          {output.name}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-aux text-muted-foreground">
          <span className="shrink-0">{t(`outputs.types.${outputTypeOf(output)}`)}</span>
          <span aria-hidden>·</span>
          <SourceText output={output} onNavigate={onNavigate} />
        </div>
      </div>
      {editToggle}
      {download}
    </div>
  );

  if (editingPath !== null) {
    return (
      <div className="flex h-full flex-col gap-3">
        {header}
        <div className="min-h-0 flex-1">
          <OutputEditor path={editingPath} textUrl={url} leaveGuard={leaveGuard} />
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="px-4 text-ui text-muted-foreground">
          {output.missing ? t("outputs.missing") : t("outputs.unavailable")}
        </p>
      </div>
    );
  }

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
  const { text: body, cut } = text.data;
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

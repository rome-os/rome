import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ChevronLeft,
  Download,
  ExternalLink,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileImage,
  FileOutput,
  FileText,
  FileVideo,
  Pencil,
  Sheet,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { describeFile, type FileKind, fileKindOfMimeType } from "@rome/api-types/file-kinds";
import { FilePreview } from "@/components/file-preview";
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

const CODE_EXTENSIONS =
  /\.(c|cc|cjs|cpp|cs|css|diff|go|h|java|js|jsx|json|kt|mjs|patch|py|rb|rs|sh|sql|swift|toml|ts|tsx|xml|ya?ml)$/i;

/**
 * What an output previews as: the server's `fileKind`, else what its MIME type
 * says (an older server's record), else its path's extension.
 */
export function fileKindOf(output: Pick<ChatOutput, "path" | "mimeType" | "fileKind">): FileKind {
  return output.fileKind ?? fileKindOfMimeType(output.mimeType) ?? describeFile(output.path).kind;
}

/**
 * Where an HTML output opens in a tab of its own: its page on the Projects or
 * Memory page, which shows it sandboxed. A shown copy opens the file it
 * copied, as that file is now. Null for any other output, and for a copy of a
 * file outside both folders, which only downloads. The route is read from
 * `links` too, since `link` names only a written file's project route and a
 * copy's asset URL. It is the file's path as it is, so each segment is
 * encoded for the URL.
 */
export function pageHrefOf(
  output: Pick<ChatOutput, "name" | "path" | "mimeType" | "fileKind" | "link" | "links">,
): string | null {
  if (outputTypeOf(output) !== "page" && output.mimeType !== "text/html") return null;
  const route = [output.link, ...(output.links ?? [])].find(
    (link): link is string => link !== null && /^\/(projects|memory)\//.test(link),
  );
  return route ? route.split("/").map(encodeURIComponent).join("/") : null;
}

/**
 * What an output is, as the list names it and draws its icon.
 */
const OUTPUT_TYPES = [
  "document",
  "image",
  "spreadsheet",
  "page",
  "audio",
  "video",
  "code",
  "file",
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

/** The iOS app's `ChatOutputType` sorts files the same way: change both together. */
export function outputTypeOf(
  output: Pick<ChatOutput, "name" | "path" | "mimeType" | "fileKind">,
): OutputType {
  const extension = /\.([a-z0-9]+)$/i.exec(output.name)?.[1]?.toLowerCase() ?? "";
  const kind = fileKindOf(output);
  if (kind === "pdf" || kind === "docx") return "document";
  if (["md", "markdown", "txt", "doc", "pptx", "ppt"].includes(extension)) return "document";
  if (["csv", "tsv", "xlsx", "xls"].includes(extension)) return "spreadsheet";
  if (["html", "htm"].includes(extension)) return "page";
  if (kind === "image") return "image";
  if (kind === "audio") return "audio";
  if (kind === "video") return "video";
  if (CODE_EXTENSIONS.test(output.name)) return "code";
  return "file";
}

/** The list's filters, in this order. */
export const FILTERS = ["all", "files", "media"] as const;
type Filter = (typeof FILTERS)[number];

/** The filters show only once a chat holds more outputs than this. */
export const FILTER_FROM = 10;

/**
 * Which filter an output falls under: Media for a picture, a video or an
 * audio file by the shared file kinds, Files for anything else.
 */
export function filterOf(output: Pick<ChatOutput, "path" | "mimeType" | "fileKind">): Filter {
  const kind = fileKindOf(output);
  return kind === "image" || kind === "video" || kind === "audio" ? "media" : "files";
}

/**
 * A file name as a title: words for dashes and underscores and a capital
 * first, with the file's own extension kept, so "trip-plan.md" reads
 * "Trip plan.md". Keep in step with the iOS app's `ChatOutput.title`.
 */
export function outputTitle(name: string): string {
  const extension = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] ?? "";
  const words = name
    .slice(0, name.length - extension.length)
    .replace(/[-_]+/g, " ")
    .trim();
  if (!words) return name;
  return words.charAt(0).toLocaleUpperCase() + words.slice(1) + extension;
}

const TYPE_ICON: Record<OutputType, { icon: ReactNode; tint: string }> = {
  document: { icon: <FileText />, tint: "bg-primary/10 text-primary" },
  spreadsheet: { icon: <Sheet />, tint: "bg-success-bg text-success-fg" },
  page: { icon: <AppWindow />, tint: "bg-info-bg text-info-fg" },
  image: { icon: <FileImage />, tint: "bg-brand/15 text-brand" },
  audio: { icon: <FileAudio />, tint: "bg-brand/15 text-brand" },
  video: { icon: <FileVideo />, tint: "bg-brand/15 text-brand" },
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
  // Back from a file, the list comes back where it was scrolled to, with the
  // file just viewed marked and focused.
  const listScroll = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [lastViewed, setLastViewed] = useState<string | null>(null);
  const restoring = useRef(false);
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
    <p role="status" className="px-3 text-aux text-muted-foreground">
      {t("outputs.indexing")}
    </p>
  ) : null;
  // The file open in the list's place: its record, or the record that replaced
  // it once the agent wrote the same file again, found by the link it had.
  const followed = useRef<{ id: string; link: string | null } | null>(null);
  const current =
    list.find((output) => output.id === chosen) ??
    list.find(
      (output) =>
        followed.current?.id === chosen &&
        followed.current.link !== null &&
        output.link === followed.current.link,
    ) ??
    null;
  if (current && chosen !== null) followed.current = { id: chosen, link: current.link };
  const showingList = !editing && !current;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!showingList || !restoring.current || !scroller) return;
    restoring.current = false;
    scroller.scrollTop = listScroll.current;
    const row = [...scroller.querySelectorAll<HTMLButtonElement>("[data-output-id]")].find(
      (button) => button.dataset.outputId === lastViewed,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
  });

  // Keyed apart from the list's, so a file opens at its top and the list keeps
  // the scroll it had.
  const preview = (output: ChatOutput) => (
    <div key="file" className="h-full overflow-y-auto pb-safe" data-testid="chat-outputs">
      <OutputPreview
        key={output.id}
        output={output}
        leaveGuard={guard}
        editingPath={editing?.path ?? null}
        onEdit={(path) => setEditing({ path, output })}
        onDone={() => leaveEditing((latest) => latest && setChosen(latest.id))}
        onBack={() =>
          leaveEditing((latest) => {
            setLastViewed(latest?.id ?? output.id);
            restoring.current = true;
            setChosen(null);
          })
        }
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
    if (indexing) {
      return (
        <p role="status" className="p-4 text-aux text-muted-foreground">
          {t("outputs.indexing")}
        </p>
      );
    }
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
  const filtered = list.length > FILTER_FROM;
  // With no filters showing, the whole list shows.
  const active = filtered ? filter : "all";
  const shown = list.filter((output) => active === "all" || filterOf(output) === active);
  const today = shown.filter((output) => sameDay(new Date(output.at), now));
  const earlier = shown.filter((output) => !sameDay(new Date(output.at), now));
  const group = (key: "today" | "earlier", items: ChatOutput[]) =>
    items.length === 0 ? null : (
      <section key={key} className="flex flex-col gap-2">
        <h3 className="px-3 text-aux text-muted-foreground">{t(`outputs.${key}`)}</h3>
        <ul
          aria-label={t(`outputs.${key}`)}
          className="divide-y divide-border-subtle overflow-hidden rounded-12 border border-border bg-surface"
        >
          {items.map((output) => (
            <OutputRow
              key={output.id}
              output={output}
              when={whenLabel(new Date(output.at), now, i18n.language)}
              viewed={output.id === lastViewed}
              onOpen={() => setChosen(output.id)}
              onNavigate={follow}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div
      key="list"
      ref={scrollerRef}
      onScroll={(event) => {
        listScroll.current = event.currentTarget.scrollTop;
      }}
      className="h-full overflow-y-auto pb-safe"
      data-testid="chat-outputs"
    >
      <div className="flex flex-col gap-4 p-4 max-md:px-3">
        {filtered && (
          <FilterChipGroup<Filter>
            aria-label={t("outputs.filterLabel")}
            value={active}
            onValueChange={setFilter}
            options={FILTERS.map((value) => ({ value, label: t(`outputs.filters.${value}`) }))}
          />
        )}
        {indexingNote}
        {shown.length === 0 ? (
          // Only a filter can leave nothing: All shows the whole, non-empty list.
          <p className="px-3 text-ui text-muted-foreground">
            {t(active === "media" ? "outputs.filterEmpty.media" : "outputs.filterEmpty.files")}
          </p>
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
  viewed,
  onOpen,
  onNavigate,
}: {
  output: ChatOutput;
  when: string;
  /** The file just viewed, marked when the list comes back. */
  viewed: boolean;
  onOpen: () => void;
  onNavigate?: FollowTaskChat;
}) {
  const { t } = useTranslation("chat");
  const type = outputTypeOf(output);
  return (
    <li
      className={cn(
        "relative flex min-w-0 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover",
        viewed && "bg-surface-muted",
      )}
    >
      <TypeIcon type={type} />
      <div className="min-w-0 flex-1">
        {/* The whole row opens the output; the task chat's link sits above it. */}
        <button
          type="button"
          onClick={onOpen}
          data-output-id={output.id}
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
  const kind = fileKindOf(output);
  const url = output.contentUrl;
  const textual = kind === "text";
  const page = pageHrefOf(output);
  const editing = editingPath !== null;
  // A text file the agent wrote into the projects folder can be edited in
  // place. Once it is being edited the folder's answer is not asked again.
  const editablePath = useEditablePath(output, textual && output.kind === "written" && !editing);
  const text = useQuery({
    queryKey: outputTextKey(url),
    queryFn: () => readPrefix(url ?? "", PREVIEW_CHARS),
    enabled: textual && Boolean(url) && !editing,
  });

  // An icon, like Edit beside it.
  const download = !url ? null : (
    <Button asChild variant="ghost" size="icon-sm">
      <a
        href={url}
        download={output.name}
        aria-label={t("outputs.download")}
        title={t("outputs.download")}
      >
        <Download />
      </a>
    </Button>
  );
  // A page draws here with nothing in it running; its own tab runs it.
  const openPage =
    page && editingPath === null ? (
      <Button asChild variant="ghost" size="icon-sm">
        <a
          href={page}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("outputs.openInNewTab")}
          title={t("outputs.openInNewTab")}
        >
          <ExternalLink />
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
  // The file's header row, in the side pane's Outputs tab and a sheet alike.
  const header = (
    <div className="flex items-center gap-2 pt-2 pr-4 pl-2">
      <IconButton size="sm" label={t("outputs.back")} icon={<ChevronLeft />} onClick={onBack} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-foreground" title={output.path}>
          {outputTitle(output.name)}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-aux text-muted-foreground">
          <span className="shrink-0">{t(`outputs.types.${outputTypeOf(output)}`)}</span>
          <span aria-hidden>·</span>
          <SourceText output={output} onNavigate={onNavigate} />
        </div>
      </div>
      {editToggle}
      {openPage}
      {download}
    </div>
  );
  const frame = "flex flex-col gap-3";

  if (editingPath !== null) {
    return (
      <div className={cn(frame, "h-full")}>
        {header}
        <div className="min-h-0 flex-1">
          <OutputEditor path={editingPath} textUrl={url} leaveGuard={leaveGuard} />
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className={frame}>
        {header}
        <p className="px-4 text-ui text-muted-foreground">
          {output.missing ? t("outputs.missing") : t("outputs.unavailable")}
        </p>
      </div>
    );
  }

  if (textual && text.isPending) {
    return (
      <div className={frame}>
        {header}
        <Skeleton className="mx-4 h-24" />
      </div>
    );
  }
  if (textual && text.isError) {
    return (
      <div className={frame}>
        {header}
        <p className="px-4 text-ui text-muted-foreground">{t("outputs.previewFailed")}</p>
      </div>
    );
  }
  const body = text.data?.text ?? "";
  return (
    <div className={cn(frame, "h-full")}>
      {header}
      {text.data?.cut && (
        <p className="px-4 text-aux text-muted-foreground">
          {t("outputs.truncated", { count: PREVIEW_CHARS })}
        </p>
      )}
      <div className="min-h-0 flex-1" data-testid="output-preview" data-kind={kind}>
        <FilePreview
          file={{
            kind,
            path: output.path,
            mimeType: output.mimeType ?? "",
            url,
            size: null,
          }}
          title={output.name}
          text={body}
          textView="preview"
          runPages={false}
          source={
            <pre className="mx-4 mb-4 overflow-x-auto rounded-8 bg-surface-muted p-3 font-mono text-aux whitespace-pre text-foreground">
              {body}
            </pre>
          }
          fallback={<p className="px-4 text-ui text-muted-foreground">{t("outputs.noPreview")}</p>}
        />
      </div>
    </div>
  );
}

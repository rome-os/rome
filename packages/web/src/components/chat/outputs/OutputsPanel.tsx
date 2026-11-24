import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ChevronDown,
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
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Markdown from "@/components/markdown";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  /\.(c|cc|cjs|cpp|cs|css|diff|go|h|java|js|jsx|json|kt|mjs|patch|py|rb|rs|sh|sql|swift|toml|ts|tsx|xml|ya?ml)$/i;

/** How the tab previews an output: never as a page that runs. */
export function previewOf(output: Pick<ChatOutput, "name" | "mimeType">): Preview {
  const type = output.mimeType ?? "";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type === "text/markdown" || /\.(md|markdown)$/i.test(output.name)) return "markdown";
  if (TEXT_TYPES.test(type) && type !== "text/html") return "text";
  return "file";
}

/**
 * Where an HTML output opens in a tab of its own: its page on the Projects or
 * Memory page, which shows it sandboxed. Null for any other output, and for an
 * HTML copy outside those folders, which only downloads. The link is the
 * file's path as it is, so each segment is encoded for the URL.
 */
export function pageHrefOf(output: Pick<ChatOutput, "name" | "mimeType" | "link">): string | null {
  if (outputTypeOf(output) !== "page" && output.mimeType !== "text/html") return null;
  if (!output.link || !/^\/(projects|memory)\//.test(output.link)) return null;
  return output.link.split("/").map(encodeURIComponent).join("/");
}

/**
 * What an output is, as the list names it and filters it. Two kinds a list
 * holds as many of keep this order: what people come back for first, working
 * files last.
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
export function outputTypeOf(output: Pick<ChatOutput, "name" | "mimeType">): OutputType {
  const extension = /\.([a-z0-9]+)$/i.exec(output.name)?.[1]?.toLowerCase() ?? "";
  const mimeType = output.mimeType ?? "";
  if (["md", "markdown", "txt", "pdf", "docx", "doc", "pptx", "ppt"].includes(extension)) {
    return "document";
  }
  if (["csv", "tsv", "xlsx", "xls"].includes(extension)) return "spreadsheet";
  if (["html", "htm"].includes(extension)) return "page";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (CODE_EXTENSIONS.test(output.name)) return "code";
  return "file";
}

/** The most kinds the filters show as chips after All; the rest wait under More. */
export const CHIP_KINDS = 3;

/** A filter row as laid out, in pixels. */
export interface FilterRowSize {
  /** The row's width. */
  width: number;
  /** The space between two chips. */
  gap: number;
  /** Where All's chip and then each kind's ends, from the row's start, side by side. */
  ends: number[];
  /** The More chip's width while it reads More. */
  more: number;
  /** The More chip's width while it names each kind, in the kinds' order. */
  moreNamed: number[];
}

/**
 * How many kinds show as chips: as many as fit beside All, and beside More
 * when any kind is left for it, up to CHIP_KINDS. More names the chosen kind
 * when it holds it, so it is measured that wide. `chosen` is the chosen kind's
 * place among the kinds, or -1 for All.
 */
export function kindsThatFit(size: FilterRowSize, chosen: number): number {
  const kinds = size.ends.length - 1;
  for (let count = Math.min(CHIP_KINDS, kinds); count > 0; count--) {
    const more =
      count === kinds
        ? 0
        : size.gap + (chosen >= count ? (size.moreNamed[chosen] ?? size.more) : size.more);
    if ((size.ends[count] ?? 0) + more <= size.width) return count;
  }
  return 0;
}

/**
 * How far past the width one more chip needs the row must grow before it
 * shows, so a width resting on the edge does not flip it back and forth.
 */
export const FIT_SLACK = 12;

/**
 * kindsThatFit as the row resizes or a filter is chosen: one fewer as soon as
 * a chip no longer fits, one more only once the row is FIT_SLACK past the
 * width it needs.
 */
export function kindsThatStillFit(size: FilterRowSize, chosen: number, previous: number): number {
  const fits = kindsThatFit(size, chosen);
  if (fits < previous) return fits;
  return Math.max(previous, kindsThatFit({ ...size, width: size.width - FIT_SLACK }, chosen));
}

/**
 * The kinds a list holds, the one it holds most of first, for its filters.
 * None while it holds one kind, which All already shows.
 */
export function kindsOf(outputs: readonly Pick<ChatOutput, "name" | "mimeType">[]): OutputType[] {
  const counts = new Map<OutputType, number>();
  for (const output of outputs) {
    const type = outputTypeOf(output);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  if (counts.size < 2) return [];
  return OUTPUT_TYPES.filter((type) => counts.has(type)).sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
  );
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

type Filter = "all" | OutputType;

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
  /**
   * Opens a chosen output somewhere else, as the side pane opens it in a tab of
   * its own. Without it the output's preview takes the list's place.
   */
  onOpenOutput?: (output: ChatOutput) => void;
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
  onOpenOutput,
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
  const kinds = kindsOf(list);
  // A chosen kind this list does not hold, as another chat's, falls back to All.
  const active = filter !== "all" && kinds.includes(filter) ? filter : "all";
  const shown = list.filter((output) => active === "all" || outputTypeOf(output) === active);
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
              onOpen={() => (onOpenOutput ? onOpenOutput(output) : setChosen(output.id))}
              onNavigate={follow}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="h-full overflow-y-auto pb-safe" data-testid="chat-outputs">
      <div className="flex flex-col gap-4 p-4 max-md:px-3">
        {kinds.length > 0 && <KindFilters kinds={kinds} value={active} onValueChange={setFilter} />}
        {indexingNote}
        <div className="flex flex-col gap-4">
          {group("today", today)}
          {group("earlier", earlier)}
        </div>
      </div>
    </div>
  );
}

/** The kit's filter chip, as More's menu trigger rather than a radio. */
function moreChipClass(chosen: boolean): string {
  return cn(
    "inline-flex shrink-0 items-center gap-1 rounded-full border px-[var(--control-filter-px)] py-1 text-badge min-h-[var(--control-min-h)] whitespace-nowrap transition-colors outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 [&_svg]:size-4",
    chosen
      ? "border-transparent bg-primary text-primary-foreground"
      : "border-border-strong bg-surface text-foreground hover:bg-surface-muted",
  );
}

/**
 * All and as many kinds as the row's width holds, up to CHIP_KINDS, with the
 * rest under More, so the row never scrolls. A hidden copy of every chip is
 * measured to tell how many fit, again whenever the row or the chips resize.
 */
function KindFilters({
  kinds,
  value,
  onValueChange,
}: {
  kinds: OutputType[];
  value: Filter;
  onValueChange: (filter: Filter) => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState(CHIP_KINDS);
  // The count last shown, kept across choosing a filter as well as resizes, so
  // a click never adds a chip that only the slack was holding back.
  const shownRef = useRef<number | null>(null);
  const count = Math.min(fitted, kinds.length);
  const chosen = value === "all" ? -1 : kinds.indexOf(value);
  const kindsKey = kinds.join(",");
  const label = (filter: Filter) => t(`outputs.filters.${filter}`);

  // Measured again whenever the kinds, the chosen one or the language change what the chips say.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const fit = () => {
      // Unrounded, as the chips are measured, so a fractional width cannot round up past them.
      const width = row.getBoundingClientRect().width;
      // Not laid out, as in a closed sheet: keep the most chips until it is.
      if (width === 0) return;
      const chips = [...measure.querySelectorAll<HTMLElement>("[data-slot=filter-chip]")];
      const start = chips[0]?.getBoundingClientRect().left ?? 0;
      const widthOf = (selector: string) =>
        measure.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
      const size: FilterRowSize = {
        width,
        gap: Number.parseFloat(getComputedStyle(row).columnGap) || 0,
        ends: chips.map((chip) => chip.getBoundingClientRect().right - start),
        more: widthOf("[data-more]"),
        moreNamed: kinds.map((kind) => widthOf(`[data-more-named="${kind}"]`)),
      };
      const next = kindsThatStillFit(size, chosen, shownRef.current ?? CHIP_KINDS);
      shownRef.current = next;
      setFitted(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [kindsKey, chosen, i18n.language]);

  return (
    // Chips a step tighter than the kit's touch spacing, so more of them fit.
    <div
      ref={rowRef}
      data-slot="output-filters"
      className="relative flex min-w-0 items-start gap-2"
      style={{ "--control-filter-px": "var(--rome-space-3)" } as CSSProperties}
    >
      <FilterChipGroup<Filter>
        aria-label={t("outputs.filterLabel")}
        value={value}
        onValueChange={onValueChange}
        options={(["all", ...kinds.slice(0, count)] as Filter[]).map((filter) => ({
          value: filter,
          label: label(filter),
        }))}
      />
      {count < kinds.length && (
        <MoreKinds kinds={kinds.slice(count)} value={value} onValueChange={onValueChange} />
      )}
      {/* Clipped to nothing, so the copy's full width never scrolls the pane. */}
      <div
        aria-hidden
        inert
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <div
          ref={measureRef}
          data-slot="output-filters-measure"
          className="flex w-max items-start gap-2"
        >
          <FilterChipGroup<Filter>
            aria-label={t("outputs.filterLabel")}
            value={value}
            onValueChange={onValueChange}
            options={(["all", ...kinds] as Filter[]).map((filter) => ({
              value: filter,
              label: label(filter),
            }))}
          />
          <span data-more className={moreChipClass(false)}>
            {t("outputs.more")}
            <ChevronDown aria-hidden />
          </span>
          {kinds.map((kind) => (
            <span key={kind} data-more-named={kind} className={moreChipClass(true)}>
              {label(kind)}
              <ChevronDown aria-hidden />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The kinds past the chips, under one chip that opens a menu of them. It reads
 * as chosen, and names the kind, while one of them filters the list.
 */
function MoreKinds({
  kinds,
  value,
  onValueChange,
}: {
  kinds: OutputType[];
  value: Filter;
  onValueChange: (kind: OutputType) => void;
}) {
  const { t } = useTranslation("chat");
  const chosen = kinds.find((kind) => kind === value);
  const chosenLabel = chosen && t(`outputs.filters.${chosen}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={chosenLabel ? t("outputs.moreChosen", { kind: chosenLabel }) : undefined}
          className={moreChipClass(Boolean(chosen))}
        >
          {chosenLabel ?? t("outputs.more")}
          <ChevronDown aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={chosen ?? ""}
          onValueChange={(next) => onValueChange(next as OutputType)}
        >
          {kinds.map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind}>
              {t(`outputs.filters.${kind}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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

/**
 * Output `opened` of chat `chatId` in a file tab of the side pane: the file
 * alone, with its Edit, Done and Download buttons in the pane's tab row. It
 * follows the file when the agent writes it again under a new record, and says
 * so when the file is gone.
 */
export function OutputFile({
  chatId,
  opened,
  actions,
  leaveGuard,
}: {
  chatId: string;
  opened: { id: string; link: string | null };
  /** Where the file's buttons go, or null while its tab is not the one showing. */
  actions: HTMLElement | null;
  /** Filled with the check the pane runs before it closes the tab. */
  leaveGuard: LeaveGuard;
}) {
  const { t } = useTranslation("chat");
  const outputs = useChatOutputs(chatId);
  const list = outputs.data?.outputs ?? [];
  const found =
    list.find((output) => output.id === opened.id) ??
    list.find((output) => opened.link !== null && output.link === opened.link) ??
    null;
  // The edit holds on to the record it began with, as the panel's does.
  const [editing, setEditing] = useState<{ path: string; output: ChatOutput } | null>(null);
  const output = editing?.output ?? found;
  if (!output) {
    if (outputs.isPending) return <Skeleton className="m-4 h-24" />;
    return (
      <p className="p-4 text-ui text-muted-foreground">
        {outputs.isError ? t("outputs.loadFailed") : t("outputs.missing")}
      </p>
    );
  }
  return (
    <div className="h-full overflow-y-auto pb-safe" data-testid="chat-output-file">
      <OutputPreview
        key={output.id}
        output={output}
        leaveGuard={leaveGuard}
        editingPath={editing?.path ?? null}
        onEdit={(path) => setEditing({ path, output })}
        onDone={() => leaveEditor(leaveGuard, () => setEditing(null))}
        actions={actions}
      />
    </div>
  );
}

function OutputPreview({
  output,
  leaveGuard,
  editingPath,
  onEdit,
  onDone,
  onBack,
  onNavigate,
  actions,
}: {
  output: ChatOutput;
  leaveGuard: LeaveGuard;
  /** The project path being edited in place of the preview, or null. */
  editingPath: string | null;
  onEdit: (path: string) => void;
  onDone: () => void;
  onBack?: () => void;
  onNavigate?: FollowTaskChat;
  /**
   * A file tab's buttons go here, and the preview draws no header, since its
   * tab names it. Undefined in a list's place, where it draws its own header
   * with a way back.
   */
  actions?: HTMLElement | null;
}) {
  const { t } = useTranslation("chat");
  const kind = previewOf(output);
  const url = output.contentUrl;
  const textual = kind === "markdown" || kind === "text";
  const editing = editingPath !== null;
  const inTab = actions !== undefined;
  // A text file the agent wrote into the projects folder can be edited in
  // place. Once it is being edited the folder's answer is not asked again.
  const editablePath = useEditablePath(output, textual && output.kind === "written" && !editing);
  const text = useQuery({
    queryKey: outputTextKey(url),
    queryFn: () => readPrefix(url ?? "", PREVIEW_CHARS),
    enabled: textual && Boolean(url) && !editing,
  });

  // In a tab's row, beside the pane's own buttons, Download is an icon too.
  const download = !url ? null : inTab ? (
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
  ) : (
    <Button asChild variant="outline" size="sm">
      <a href={url} download={output.name}>
        <Download data-icon="inline-start" />
        {t("outputs.download")}
      </a>
    </Button>
  );
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
  const header = inTab ? (
    actions ? (
      createPortal(
        <>
          {editToggle}
          {download}
        </>,
        actions,
      )
    ) : null
  ) : (
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
  // With no header above it, the file starts a step below the tab row.
  const frame = cn("flex flex-col gap-3", inTab && "pt-4");

  if (editingPath !== null) {
    return (
      <div className={cn(frame, "h-full", inTab && "pt-0")}>
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

  if (kind === "image") {
    return (
      <div className={frame}>
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
    const page = pageHrefOf(output);
    return (
      <div className={frame}>
        {header}
        <p className="px-4 text-ui text-muted-foreground">
          {page ? t("outputs.pageNoPreview") : t("outputs.noPreview")}
        </p>
        {page && (
          <Button asChild variant="outline" size="sm" className="mx-4 self-start">
            <a href={page} target="_blank" rel="noopener noreferrer">
              <ExternalLink data-icon="inline-start" />
              {t("outputs.openInNewTab")}
            </a>
          </Button>
        )}
      </div>
    );
  }
  if (text.isPending) {
    return (
      <div className={frame}>
        {header}
        <Skeleton className="mx-4 h-24" />
      </div>
    );
  }
  if (text.isError) {
    return (
      <div className={frame}>
        {header}
        <p className="px-4 text-ui text-muted-foreground">{t("outputs.previewFailed")}</p>
      </div>
    );
  }
  const { text: body, cut } = text.data;
  return (
    <div className={cn(frame, "pb-4")}>
      {header}
      {cut && (
        <p className="px-4 text-aux text-muted-foreground">
          {t("outputs.truncated", { count: PREVIEW_CHARS })}
        </p>
      )}
      {kind === "markdown" ? (
        <div className="px-4" data-testid="output-markdown">
          <Markdown>{body}</Markdown>
        </div>
      ) : (
        <pre className="mx-4 overflow-x-auto rounded-8 bg-surface-muted p-3 font-mono text-aux whitespace-pre text-foreground">
          {body}
        </pre>
      )}
    </div>
  );
}

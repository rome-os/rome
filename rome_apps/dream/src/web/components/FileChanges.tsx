import type { ReactNode } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { navigateRome } from "@rome-os/app-web-sdk";
import { Badge } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
import { cn } from "@rome-os/ui/cn";
import type { ChangedFile } from "../lib/api";
import { foldContext, lineDiff, type DiffRow } from "../lib/diff";

type Change = ChangedFile["changes"][number];

const MARKER = { added: "+", removed: "−", context: " " } as const;
const SR_LABEL = { added: "Added: ", removed: "Removed: ", context: "" } as const;

/** One edit as a line diff, unchanged lines far from the change folded away. */
function DiffBlock({ previous, content }: { previous: string; content: string }) {
  const rows: DiffRow[] = foldContext(lineDiff(previous, content));
  return (
    <div className="overflow-x-auto py-2 font-mono text-aux">
      {rows.map((row, i) =>
        row.type === "skip" ? (
          <div key={i} className="px-3 py-0.5 text-subtle-foreground">
            ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "flex gap-2 px-3",
              row.type === "added" && "bg-success-bg text-success-fg",
              row.type === "removed" && "bg-destructive-bg text-destructive-fg",
              row.type === "context" && "text-muted-foreground",
            )}
          >
            <span aria-hidden className="w-3 shrink-0 select-none text-center">
              {MARKER[row.type]}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              <span className="sr-only">{SR_LABEL[row.type]}</span>
              {row.text || " "}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

/** A whole file the agent wrote, as plain text. */
function WrittenText({ content }: { content: string }) {
  return (
    <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-aux whitespace-pre-wrap break-words text-foreground">
      {content}
    </pre>
  );
}

/** Says that a stored change lost its tail to the 20,000-character cap. */
export function TruncatedNote({ className }: { className?: string }) {
  return (
    <p className={cn("px-3 pb-2 text-aux text-muted-foreground", className)}>
      Shortened to the first 20,000 characters.
    </p>
  );
}

export function ChangeBody({ change }: { change: Change }) {
  return (
    <div>
      {change.op === "edit" ? (
        <DiffBlock previous={change.previous ?? ""} content={change.content} />
      ) : (
        <WrittenText content={change.content} />
      )}
      {change.truncated ? <TruncatedNote /> : null}
    </div>
  );
}

function changeLabel(file: ChangedFile): string {
  const edits = file.changes.filter((c) => c.op === "edit").length;
  if (edits === file.changes.length) return edits === 1 ? "1 edit" : `${edits} edits`;
  return edits === 0 ? "Written" : `Written, ${edits === 1 ? "1 edit" : `${edits} edits`}`;
}

export function OpenInMemoryButton({ file }: { file: string }) {
  return (
    <Button size="sm" variant="ghost" onClick={() => navigateRome({ path: "memory", file })}>
      Open
      <ArrowUpRight data-icon="inline-end" />
    </Button>
  );
}

/** A bordered block for one file: a header row, then its contents. */
export function FilePanel({
  icon,
  title,
  meta,
  action,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-12 border border-border bg-surface">
      <div className="flex min-h-11 items-center gap-2 border-b border-border-subtle py-1.5 pr-1.5 pl-3">
        <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
          {icon ?? <FileText />}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">{title}</div>
        {meta}
        {action}
      </div>
      {children}
    </div>
  );
}

export function FileChangeCard({ file }: { file: ChangedFile }) {
  return (
    <FilePanel
      title={<span className="truncate font-mono text-aux text-foreground">{file.label}</span>}
      meta={<Badge variant="muted">{changeLabel(file)}</Badge>}
      action={file.memoryFile ? <OpenInMemoryButton file={file.memoryFile} /> : null}
    >
      <div className="divide-y divide-border-subtle">
        {file.changes.map((change, i) => (
          <ChangeBody key={i} change={change} />
        ))}
      </div>
    </FilePanel>
  );
}

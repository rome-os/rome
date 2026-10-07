import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { navigateRome } from "@rome-os/app-web-sdk";
import { BookMarked, CircleAlert, CircleSlash, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Badge } from "@rome-os/ui/badge";
import { Skeleton } from "@rome-os/ui/skeleton";
import { Spinner } from "@rome-os/ui/spinner";
import { Timestamp } from "@rome-os/ui/timestamp";
import {
  LIVE_REFETCH_MS,
  fetchRun,
  queryKeys,
  type ChangedFile,
  type RunDetail as Run,
} from "../lib/api";
import { splitFrontmatter, stripLeadingTitle } from "../lib/diff";
import { KIND_LABEL, formatDuration } from "../lib/format";
import { ChangeBody, FileChangeCard, FilePanel, OpenInMemoryButton } from "./FileChanges";
import { Prose } from "./Prose";
import { RunIcon } from "./RunIcon";

/** What the skill-review agent replies when it saves nothing. */
const NOTHING_TO_UPDATE = "Nothing to update.";

export function RunDetailPane({ runId }: { runId: string }) {
  const { data: run, error } = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: () => fetchRun(runId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? LIVE_REFETCH_MS : 30_000),
  });

  if (!run) {
    if (error) {
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Failed to load this run</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      );
    }
    return <DetailSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Updates are failing</AlertTitle>
          <AlertDescription>Showing the last loaded run. {error.message}</AlertDescription>
        </Alert>
      ) : null}
      <RunDetailView run={run} />
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-12" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-48 w-full rounded-12" />
      <Skeleton className="h-32 w-full rounded-12" />
    </div>
  );
}

function RunDetailView({ run }: { run: Run }) {
  const duration = formatDuration(run.startedAt, run.finishedAt);
  return (
    <article className="flex min-w-0 flex-col gap-6" aria-labelledby={`run-${run.id}`}>
      <header className="flex items-start gap-3">
        <RunIcon run={run} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={`run-${run.id}`} className="text-section text-foreground">
            {KIND_LABEL[run.kind]}
          </h2>
          <p className="flex flex-wrap items-center gap-x-1.5 text-ui text-muted-foreground">
            <Timestamp value={run.startedAt} format="datetime" />
            {duration ? <Meta>{duration}</Meta> : null}
            {run.kind === "dream" && run.windowHours ? (
              <Meta>Reviewed the last {run.windowHours} hours</Meta>
            ) : null}
            {run.reviewedSession ? (
              <Meta>
                Reviewed{" "}
                <button
                  type="button"
                  className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                  onClick={() => navigateRome({ path: "chat", sessionId: run.reviewedSession!.id })}
                >
                  {run.reviewedSession.name || "the conversation"}
                </button>
              </Meta>
            ) : null}
          </p>
        </div>
      </header>

      <StatusNotice run={run} />

      {/* A dream's summary is the overview of many changes, so it leads. A
          skill review's restates the skill card, so it trails. */}
      {run.kind === "dream" ? (
        <>
          <Summary run={run} />
          <DreamResults run={run} />
        </>
      ) : (
        <>
          <SkillReviewResults run={run} />
          <Summary run={run} />
        </>
      )}
    </article>
  );
}

function Summary({ run }: { run: Run }) {
  if (!run.summary || run.summary.trim() === NOTHING_TO_UPDATE) return null;
  return (
    <ResultSection title="Summary">
      <div className="rounded-12 border border-border bg-surface px-4 py-3">
        <Prose>{run.summary}</Prose>
      </div>
    </ResultSection>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return (
    <>
      <span aria-hidden className="text-subtle-foreground">
        ·
      </span>
      <span>{children}</span>
    </>
  );
}

function StatusNotice({ run }: { run: Run }) {
  switch (run.status) {
    case "running":
      return (
        <Alert variant="info">
          <Spinner size="sm" />
          <AlertTitle>{run.kind === "dream" ? "Dreaming" : "Reviewing"}</AlertTitle>
          <AlertDescription>Changes appear here as the agent makes them.</AlertDescription>
        </Alert>
      );
    case "failed":
      return (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{run.kind === "dream" ? "Dream failed" : "Review failed"}</AlertTitle>
          {run.error ? <AlertDescription>{run.error}</AlertDescription> : null}
        </Alert>
      );
    case "interrupted":
      return (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Stopped before finishing</AlertTitle>
          <AlertDescription>
            The run never reported a result, usually because Rome restarted while it ran. Changes
            recorded before that are listed below.
          </AlertDescription>
        </Alert>
      );
    case "completed":
      return null;
  }
}

function ResultSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-ui font-medium text-foreground">
          {title}
          {count ? <span className="ml-2 font-normal text-muted-foreground">{count}</span> : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function filesCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** Nothing came out of a run that finished; said once, quietly. */
function NoResult({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-12 border border-dashed border-border px-4 py-5 text-ui text-muted-foreground">
      <CircleSlash className="size-4 shrink-0" aria-hidden />
      {children}
    </div>
  );
}

function DreamResults({ run }: { run: Run }) {
  const journal = run.files.find((f) => f.area === "journal");
  const memory = run.files.filter((f) => f.area === "memory");
  const other = run.files.filter((f) => f.area === "skill" || f.area === "other");

  if (run.files.length === 0) {
    return run.status === "completed" ? (
      <NoResult>This dream found nothing new to remember.</NoResult>
    ) : null;
  }

  return (
    <>
      {journal ? <JournalSection file={journal} /> : null}
      {memory.length > 0 ? (
        <ResultSection title="Memory updates" count={filesCount(memory.length)}>
          {memory.map((file) => (
            <FileChangeCard key={file.path} file={file} />
          ))}
        </ResultSection>
      ) : null}
      {other.length > 0 ? (
        <ResultSection title="Other files" count={filesCount(other.length)}>
          {other.map((file) => (
            <FileChangeCard key={file.path} file={file} />
          ))}
        </ResultSection>
      ) : null}
    </>
  );
}

function lastWriteIndex(file: ChangedFile): number {
  for (let i = file.changes.length - 1; i >= 0; i--) {
    if (file.changes[i]?.op === "write") return i;
  }
  return -1;
}

/** The journal entry, rendered as the guardian would read it in Memory. */
function JournalSection({ file }: { file: ChangedFile }) {
  const lastWrite = lastWriteIndex(file);
  const entry = lastWrite >= 0 ? file.changes[lastWrite] : undefined;
  const laterEdits = file.changes.slice(lastWrite + 1);
  return (
    <ResultSection
      title="Journal"
      action={file.memoryFile ? <OpenInMemoryButton file={file.memoryFile} /> : null}
    >
      {entry ? (
        <div className="rounded-12 border border-border bg-surface px-5 py-4">
          <Prose>{stripLeadingTitle(entry.content)}</Prose>
        </div>
      ) : null}
      {laterEdits.length > 0 ? <FileChangeCard file={{ ...file, changes: laterEdits }} /> : null}
    </ResultSection>
  );
}

function SkillReviewResults({ run }: { run: Run }) {
  const skills = run.files.filter((f) => f.area === "skill");
  const other = run.files.filter((f) => f.area !== "skill");

  return (
    <>
      {skills.length > 0 ? (
        <ResultSection title={skills.length === 1 ? "Skill" : "Skills"}>
          {skills.map((file) => (
            <SkillCard key={file.path} file={file} />
          ))}
        </ResultSection>
      ) : run.status === "completed" ? (
        <NoResult>Nothing in this conversation was worth saving as a skill.</NoResult>
      ) : null}
      {other.length > 0 ? (
        <ResultSection title="Other files" count={filesCount(other.length)}>
          {other.map((file) => (
            <FileChangeCard key={file.path} file={file} />
          ))}
        </ResultSection>
      ) : null}
    </>
  );
}

function SkillCard({ file }: { file: ChangedFile }) {
  const created = file.changes.some((c) => c.op === "write");
  const lastWrite = file.changes[lastWriteIndex(file)];
  const written = lastWrite ? splitFrontmatter(lastWrite.content) : null;
  return (
    <FilePanel
      icon={<BookMarked />}
      title={
        <>
          <span className="truncate text-ui font-medium text-foreground">
            {file.skillName ?? file.label}
          </span>
          {file.skillAppId ? (
            <span className="text-aux text-muted-foreground">in {file.skillAppId}</span>
          ) : null}
        </>
      }
      meta={
        <Badge variant={created ? "success" : "info"}>{created ? "New skill" : "Updated"}</Badge>
      }
    >
      {written?.description ? (
        <p className="border-b border-border-subtle px-3 py-2 text-ui text-muted-foreground">
          {written.description}
        </p>
      ) : null}
      {written && file.changes.every((c) => c.op === "write") ? (
        <div className="max-h-[32rem] overflow-auto px-4 py-3">
          <Prose>{written.body}</Prose>
        </div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {file.changes.map((change, i) => (
            <ChangeBody key={i} change={change} />
          ))}
        </div>
      )}
    </FilePanel>
  );
}

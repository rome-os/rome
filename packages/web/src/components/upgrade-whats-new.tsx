import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReleaseNotesRange, ReleaseNotesRangeEntry } from "@rome/api-types/release-notes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useReleaseNotes } from "@/hooks/use-release-notes";
import { cn } from "@/lib/utils";
import { scopeName } from "@/lib/release-scope";

/** New features and fixes listed before "Show all". Breaking changes always show in full. */
export const COLLAPSED_ENTRIES = 5;

/**
 * The upgrade dialog's "What's new": what moving from `from`, the running
 * release, to `to` changes. Mount it with `key={to}`, so a new target starts
 * collapsed. Whatever the notes' state, it never holds up the dialog's
 * buttons.
 */
export function UpgradeWhatsNew({
  from,
  to,
  className,
}: {
  from: string | null;
  to: string;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const query = useReleaseNotes(from, to);
  // Keyed by both versions, but checked again: notes for any other target
  // must never describe this one.
  const notes = query.data && query.data.to === to ? query.data : null;

  let heading: string;
  if (notes && notes.releases.length > 0) {
    const start = notes.status === "complete" ? notes.from : notes.coveredFrom;
    const count = notes.releases.length;
    heading =
      count === 1 && notes.status === "complete"
        ? t("system.notesSingle", { version: to })
        : start
          ? t("system.notesRange", { from: start, to, count })
          : t("system.notesUpTo", { to, count });
  } else {
    heading = from
      ? t("system.notesRangePending", { from, to })
      : t("system.notesSingle", { version: to });
  }

  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div>
        <h3 id={headingId} className="text-ui font-medium text-foreground">
          {heading}
        </h3>
        {notes?.releases[0] ? <ReleasedOn date={notes.releases[0].date} /> : null}
      </div>
      {query.isPending ? (
        <div role="status" aria-label={t("system.notesLoading")} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : notes === null || notes.status === "failed" ? (
        <Fallback text={t("system.notesFailed")} url={notes?.releaseUrl ?? releasePage(to)} />
      ) : notes.status === "missing" ? (
        <Fallback text={t("system.notesMissing", { version: to })} url={notes.releaseUrl} />
      ) : (
        <Loaded notes={notes} />
      )}
    </section>
  );
}

/** The release page, for when the server's answer did not arrive. */
function releasePage(version: string): string {
  return `https://github.com/rome-os/rome/releases/tag/v${version}`;
}

function ReleasedOn({ date }: { date: string }) {
  const { t, i18n } = useTranslation("settings");
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return null;
  const formatted = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(at);
  return (
    <p className="text-aux text-muted-foreground">
      {t("system.notesReleased", { date: formatted })}
    </p>
  );
}

function Fallback({ text, url }: { text: string; url: string }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-ui text-muted-foreground">{text}</p>
      <ExternalLink href={url}>{t("system.notesOnGitHub")}</ExternalLink>
    </div>
  );
}

function Loaded({ notes }: { notes: ReleaseNotesRange }) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(false);
  const multi = notes.releases.length > 1 || notes.status === "partial";
  const listed = notes.new.length + notes.fixes.length;
  const hidden = expanded ? 0 : Math.max(0, listed - COLLAPSED_ENTRIES);
  // The collapsed view fills from New first, then Fixes.
  const shownNew = expanded ? notes.new : notes.new.slice(0, COLLAPSED_ENTRIES);
  const shownFixes = expanded
    ? notes.fixes
    : notes.fixes.slice(0, Math.max(0, COLLAPSED_ENTRIES - shownNew.length));

  return (
    <>
      {notes.status === "partial" ? (
        <p className="text-aux text-muted-foreground">
          {notes.coveredFrom
            ? t("system.notesPartial", { version: notes.coveredFrom })
            : t("system.notesPartialUnknown")}
        </p>
      ) : null}
      {notes.breaking.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>{t("system.notesBreaking")}</AlertTitle>
          <AlertDescription>
            <EntryList entries={notes.breaking} withVersion={multi} />
          </AlertDescription>
        </Alert>
      ) : null}
      {shownNew.length > 0 ? (
        <EntrySection title={t("system.notesNew")} entries={shownNew} />
      ) : null}
      {shownFixes.length > 0 ? (
        <EntrySection title={t("system.notesFixes")} entries={shownFixes} />
      ) : null}
      {notes.breaking.length === 0 && listed === 0 ? (
        <p className="text-ui text-muted-foreground">{t("system.notesNone")}</p>
      ) : null}
      {notes.internal > 0 && (expanded || hidden === 0) ? (
        <p className="text-aux text-muted-foreground">
          {t("system.notesInternal", { count: notes.internal })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {listed > COLLAPSED_ENTRIES ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t("system.notesShowFewer") : t("system.notesShowAll", { count: listed })}
          </Button>
        ) : null}
        <ExternalLink href={multi && notes.compareUrl ? notes.compareUrl : notes.releaseUrl}>
          {multi ? t("system.notesAllChanges") : t("system.notesFull")}
        </ExternalLink>
      </div>
    </>
  );
}

function EntrySection({ title, entries }: { title: string; entries: ReleaseNotesRangeEntry[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-aux font-medium text-muted-foreground">{title}</h4>
      <EntryList entries={entries} withVersion={false} />
    </div>
  );
}

function EntryList({
  entries,
  withVersion,
}: {
  entries: ReleaseNotesRangeEntry[];
  withVersion: boolean;
}) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-ui">
      {entries.map((entry, index) => (
        <li key={`${entry.version}-${entry.pr ?? index}`} className="[overflow-wrap:anywhere]">
          {entry.scope ? <span className="font-medium">{scopeName(entry.scope)}: </span> : null}
          {sentenceCase(entry.text)}
          {withVersion ? (
            <span className="text-aux text-muted-foreground"> · {entry.version}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <Button asChild variant="link" size="sm" className="h-auto px-0">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </Button>
  );
}

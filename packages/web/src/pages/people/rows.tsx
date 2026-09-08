import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Avatar, AVATAR_TONE, GUARDIAN_TONE } from "./avatar";
import { ChannelGlyph, ChannelPill } from "./channel-meta";
import { timeAgo } from "./format";
import { isRowFixed, rowHandle, type PeopleRow, type RowLevel } from "./people-model";

// The three rows the page renders. They differ by what the reader is doing:
// routing to whoever has something new (stream), deciding where an unplaced
// account belongs (unknown), or reading the roster (directory). Avatars are
// neutral everywhere — a channel is a glyph on this page, never a color.

const LEVEL_LABEL_KEY: Record<RowLevel, string> = {
  unknown: "levels.unknown",
  guardian: "levels.guardian",
  "inner-circle": "levels.innerCircle",
  acquaintance: "levels.acquaintance",
  other: "levels.other",
  stranger: "levels.stranger",
};

export function levelLabelKey(level: RowLevel): string {
  return LEVEL_LABEL_KEY[level];
}

export const ROW_BASE =
  "grid w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left last:border-b-0";

/**
 * A stream row carries only what routing needs: who, what they said, where it
 * came from, how long ago. Bond and linked accounts live on the person page.
 *
 * Only a person's row opens a dossier: a dossier is a merged history, and a
 * history is what a person has. An account nobody has placed carries its own
 * evidence on the row instead — see {@link UnknownRow}.
 */
export function StreamRow({ row, onOpen }: { row: PeopleRow; onOpen?: () => void }) {
  const { t } = useTranslation("people");
  const body = (
    <>
      <Avatar name={row.displayName} />
      <span className="grid min-w-0 gap-1 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,1.8fr)] sm:items-center sm:gap-3">
        <span className="truncate text-ui text-foreground">{row.displayName}</span>
        <span className="flex min-w-0 items-center gap-2 text-aux text-muted-foreground">
          {row.latest && (
            <span className="text-subtle-foreground" title={row.latest.source}>
              <ChannelGlyph channel={row.latest.source} />
            </span>
          )}
          {row.latest?.preview ? (
            <span className="truncate">{row.latest.preview}</span>
          ) : row.latest ? (
            <span className="truncate italic text-subtle-foreground">{t("row.noPreview")}</span>
          ) : (
            <span className="truncate italic text-subtle-foreground">{t("row.noActivity")}</span>
          )}
        </span>
      </span>
      <span className="justify-self-end font-mono text-badge tabular-nums text-subtle-foreground">
        {timeAgo(t, row.latest?.timestamp ?? null)}
      </span>
    </>
  );

  const className = cn(ROW_BASE, "grid-cols-[2rem_minmax(0,1fr)_auto]");
  if (!onOpen) return <div className={className}>{body}</div>;
  return (
    <button type="button" onClick={onOpen} className={cn(className, "hover:bg-surface")}>
      {body}
    </button>
  );
}

/**
 * An unplaced account's row: dense on purpose. Placement decisions run on the
 * evidence — which channel, which number, how much they have said — so all of
 * it is on the row rather than a click away.
 *
 * `actions` is whatever gesture the page offers for the position it is in:
 * placing it, or taking a dismissal back. The gestures themselves are
 * `people/triage.tsx`; the row only says where they go. They show on the row
 * under the pointer, or holding focus, so a screen of rows reads as evidence
 * rather than as a wall of buttons. Hover is not a thing on touch screens, so
 * there they stay put.
 */
export function UnknownRow({ row, actions }: { row: PeopleRow; actions?: React.ReactNode }) {
  const { t } = useTranslation("people");
  const handle = rowHandle(row);
  const channel = row.accounts[0]?.channel;
  return (
    <div
      className={cn(
        ROW_BASE,
        "group grid-cols-[2rem_minmax(0,1fr)_auto] hover:bg-surface sm:grid-cols-[2rem_minmax(10rem,1.1fr)_minmax(0,1.6fr)_auto]",
      )}
    >
      <Avatar name={row.displayName} />
      <span className="min-w-0 text-left">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-ui text-foreground">{row.displayName}</span>
          {channel && <ChannelPill channel={channel} />}
        </span>
        <span className="block truncate text-aux text-muted-foreground">
          {handle && <span className="font-mono tabular-nums">{handle}</span>}
          {handle && row.messageCount > 0 && " · "}
          {row.messageCount > 0 && (
            <span className="tabular-nums">
              {t("row.messageCount", { count: row.messageCount })}
            </span>
          )}
        </span>
      </span>
      <span className="hidden min-w-0 text-left text-aux text-muted-foreground sm:block">
        <span className="block truncate">{row.latest?.preview ?? ""}</span>
      </span>
      <span className="flex items-center justify-end gap-2">
        <span className="font-mono text-badge tabular-nums text-subtle-foreground">
          {timeAgo(t, row.latest?.timestamp ?? null)}
        </span>
        {actions && (
          <span className="touch-show flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
            {actions}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * A directory row says who only: avatar, name, and the identifier the person
 * is recognized by. Nothing about what anyone said — the directory read carries
 * none of it, which is what makes this a contacts list rather than a second
 * stream. Clicking a person opens their dossier; an account has none to open
 * until it is placed on somebody.
 *
 * `actions` is whatever gesture the row's position admits: a `⋯` menu placing
 * an account nobody has decided about, or taking a dismissal back. The gestures
 * themselves are `people/triage.tsx`; the row only says where they go.
 */
export function DirectoryRow({
  row,
  selected,
  onOpen,
  onToggleSelect,
  actions,
}: {
  row: PeopleRow;
  /** Whether this row is in the selection a bulk gesture would apply to. */
  selected?: boolean;
  onOpen?: () => void;
  /** Given, the avatar becomes the selection control. Omitted — as the page
   *  leaves it until the bulk bar lands — the avatar is an ornament and the row
   *  carries no selection state. */
  onToggleSelect?: () => void;
  actions?: React.ReactNode;
}) {
  const { t } = useTranslation("people");
  const fixed = isRowFixed(row);
  const handle = rowHandle(row);

  const who = (
    <>
      <span className="block truncate text-ui text-foreground">{row.displayName}</span>
      <span className="block truncate text-aux text-muted-foreground">
        {fixed ? (
          t("guardian.meta")
        ) : (
          <span className="font-mono tabular-nums">{handle ?? ""}</span>
        )}
      </span>
    </>
  );

  return (
    <div
      className={cn(
        ROW_BASE,
        "grid-cols-[2rem_minmax(0,1fr)_auto]",
        fixed ? "cursor-default" : "hover:bg-surface",
        selected && "bg-primary/10 hover:bg-primary/15",
      )}
    >
      {fixed || !onToggleSelect ? (
        <Avatar name={row.displayName} tone={fixed ? GUARDIAN_TONE : AVATAR_TONE} />
      ) : (
        // Selecting is what the avatar does in the roster — the design's way
        // into the bulk bar, and the reason this column is a control rather
        // than an ornament.
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={selected}
          aria-label={t("actions.select", { name: row.displayName })}
          className="rounded-full outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Avatar name={row.displayName} />
        </button>
      )}
      {onOpen && !fixed ? (
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          {who}
        </button>
      ) : (
        <span className="min-w-0">{who}</span>
      )}
      <span className="flex items-center justify-end gap-2">{actions}</span>
    </div>
  );
}

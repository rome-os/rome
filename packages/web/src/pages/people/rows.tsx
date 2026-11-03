import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ListRow } from "@/components/ui/list-row";
import { Avatar, AVATAR_TONE, GUARDIAN_TONE } from "./avatar";
import { ChannelGlyph, channelLabel } from "./channel-meta";
import { isRowFixed, rowHandle, type PeopleRow, type RowLevel } from "./people-model";
import { accountHandle } from "./send-model";

// The row the page renders: the roster's contacts line, for a person and for an
// account nobody has placed alike. Avatars are neutral everywhere — a channel is
// a glyph on this page, never a color.

const LEVEL_LABEL_KEY: Record<RowLevel, string> = {
  stranger: "levels.stranger",
  guardian: "levels.guardian",
  "inner-circle": "levels.innerCircle",
  acquaintance: "levels.acquaintance",
  other: "levels.other",
  dismissed: "levels.dismissed",
};

export function levelLabelKey(level: RowLevel): string {
  return LEVEL_LABEL_KEY[level];
}

/**
 * Every row on the page is a grid rather than the kit's flex row, so the
 * avatar column and the trailing column line up down the whole list. The
 * inset, the height floor, and the hover paint are `ListRow`'s.
 */
const ROW_GRID = "grid grid-cols-[2rem_minmax(0,1fr)_auto]";

/**
 * A directory row says who only: avatar, name, and the identifier the person
 * is recognized by. Nothing about what anyone said — the directory read carries
 * none of it, which is what makes this a contacts list. Clicking a person opens their dossier; an account has none to open
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
      {/* The guardian's line wraps rather than truncating: it carries their
          accounts or the pointer to linking one, and either clipped on a phone
          loses what the line is for. */}
      <span
        className={cn("block text-aux text-muted-foreground", fixed ? "break-words" : "truncate")}
      >
        {fixed ? (
          <GuardianAccounts accounts={row.accounts} />
        ) : (
          <span className="font-mono tabular-nums">{handle ?? ""}</span>
        )}
      </span>
    </>
  );

  return (
    // Hand-rolled hover again, and again not `interactive`: the row holds three
    // separate targets — select, open, and the menu — so the row itself is none
    // of them. The fill marks the row the pointer is over, and predates the
    // move onto `ListRow`.
    <ListRow selected={selected} className={cn(ROW_GRID, !selected && "hover:bg-surface-hover")}>
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
          className="rounded-full outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
        >
          <Avatar name={row.displayName} />
        </button>
      )}
      {onOpen ? (
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          {who}
        </button>
      ) : (
        <span className="min-w-0">{who}</span>
      )}
      <span className="flex items-center justify-end gap-2">{actions}</span>
    </ListRow>
  );
}

/**
 * The guardian's line under their name: the accounts that are theirs, each by
 * its channel glyph and handle, so the roster answers "which accounts are me"
 * without opening the person page. With none linked yet it says so, since the
 * guardian's next step is "Link my account" beside the page title.
 */
function GuardianAccounts({ accounts }: { accounts: PeopleRow["accounts"] }) {
  const { t } = useTranslation("people");
  if (accounts.length === 0) return <>{t("guardian.noAccounts")}</>;
  return (
    // A handle longer than the row, such as a work email on a phone, breaks
    // rather than overflowing it.
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="shrink-0">{t("guardian.you")}</span>
      {accounts.map((account) => (
        <span
          key={`${account.channel}:${account.channelUserId}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1"
        >
          <span className="shrink-0">
            <ChannelGlyph channel={account.channel} />
            {/* The glyph is hidden from assistive tech, so the platform is
                named for it here. */}
            <span className="sr-only">{channelLabel(t, account.channel)}</span>
          </span>
          <span className="min-w-0 break-all font-mono tabular-nums">{accountHandle(account)}</span>
        </span>
      ))}
    </span>
  );
}

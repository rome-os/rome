import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilterChipGroup } from "@/components/ui/filter-chip-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar } from "@/pages/people/avatar";
import { CHANNEL_META, ChannelGlyph, channelLabel } from "@/pages/people/channel-meta";
import { FILTER_ORDER, type PeopleRow, type RowLevel } from "@/pages/people/people-model";
import { DirectoryRow, levelLabelKey } from "@/pages/people/rows";
import { List } from "@/components/ui/list-row";

// Live specimens for the People-page design note (people-page.mdx).
//
// These are the page's own components against literal fixtures — no data
// fetching, no write path — so the note shows what ships rather than a second
// copy of it. Specimens that drew their own rows would go on looking right
// after the page stopped, which is the one thing a live note exists to prevent.
//
// What is written here is only what the page does not carry yet: the `⋯` menu
// and the bulk bar. The page's writes are on the /people contract, and those
// two are the surfaces still ahead of it — a bulk gesture is N writes with one
// confirmation, which the contract's verbs do not answer on their own.

/** A row in the shape the page and these specimens render. */
function row(
  over: Partial<PeopleRow> & Pick<PeopleRow, "id" | "displayName" | "level">,
): PeopleRow {
  const account = over.accounts?.[0];
  return {
    kind: over.level === "stranger" || over.level === "dismissed" ? "account" : "person",
    accounts: [],
    addresses: account ? [account.channelUserId] : [],
    ...over,
  };
}

/** One account on a channel, as a row carries it. */
const on = (channel: string, channelUserId: string) => [
  { channel, channelUserId, displayName: channelUserId },
];

/* ---------------------------------------------------------------- channels */

/** Every glyph the page can draw, side by side, at muted foreground. One entry
 *  per name — a personal-account channel draws its network's glyph and answers
 *  to its network's name, so it is the same entry — and the last is a channel
 *  `CHANNEL_META` has no entry for, a Rome App's, which is the branch every
 *  channel added after this page was written lands in. */
export function ChannelGlyphSet() {
  const { t } = useTranslation("people");
  const named = new Set<string>();
  const channels: string[] = [];
  for (const [channel, meta] of Object.entries(CHANNEL_META)) {
    if (named.has(meta.labelKey)) continue;
    named.add(meta.labelKey);
    channels.push(channel);
  }
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-12 border border-border bg-surface p-4">
      {[...channels, "rome-app"].map((channel) => (
        <span key={channel} className="flex items-center gap-2 text-aux text-muted-foreground">
          <ChannelGlyph channel={channel} />
          {channelLabel(t, channel)}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * The row menu the design gives every actionable row: a move to each level the
 * row is not already at, then merge.
 *
 * Written here rather than imported, because it is a piece of the design the
 * page does not carry yet. The gestures behind it exist — a level on a person
 * is `PATCH /api/people/:id`, and the unplaced ends of the ladder are the
 * account's own verbs — but they reach the page from the row and the dossier
 * rather than from one menu that enumerates targets. When a menu lands, this
 * comes out and the specimen renders the shipped one.
 */
function RowMenu({ row: subject }: { row: PeopleRow }) {
  const { t } = useTranslation("people");
  const targets = (["inner-circle", "acquaintance", "other", "dismissed"] as RowLevel[]).filter(
    (level) => level !== subject.level,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("actions.rowMenu", { name: subject.displayName })}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("actions.moveTo")}</DropdownMenuLabel>
        {targets.map((level) => (
          <DropdownMenuItem key={level} variant={level === "dismissed" ? "destructive" : "default"}>
            {t(levelLabelKey(level))}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem>{t("actions.mergeInto")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The chrome around one specimen. The padding sits on the frame rather than on
 * the `List`, which owns the hairline between rows and nothing else.
 *
 * `grouped` is for a specimen whose children are sections rather than rows: it
 * leaves the `List` to the caller, so each group separates its own rows the way
 * the live page does.
 */
function Frame({
  children,
  label,
  grouped = false,
}: {
  children: React.ReactNode;
  label?: string;
  grouped?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-12 border border-border bg-background">
      {label && (
        <div className="border-b border-border-subtle bg-surface px-3 py-1 text-badge text-subtle-foreground">
          {label}
        </div>
      )}
      <div className="p-2">{grouped ? children : <List>{children}</List>}</div>
    </div>
  );
}

/* --------------------------------------------------------------- directory */

const DIRECTORY: { level: RowLevel; total: number; rows: PeopleRow[] }[] = [
  {
    level: "guardian",
    total: 1,
    rows: [
      row({
        id: "me",
        displayName: "Fan Zhang",
        level: "guardian",
        accounts: on("webchat", "wc-1"),
      }),
    ],
  },
  {
    level: "inner-circle",
    total: 2,
    rows: [
      row({
        id: "mira",
        displayName: "Mira Okafor",
        level: "inner-circle",
        accounts: on("whatsapp", "12065550113@s.whatsapp.net"),
      }),
      row({
        id: "priya",
        displayName: "Priya Raman",
        level: "inner-circle",
        accounts: on("discord", "@priya"),
      }),
    ],
  },
  {
    level: "acquaintance",
    total: 2,
    rows: [
      row({
        id: "dan",
        displayName: "Dan Levy",
        level: "acquaintance",
        accounts: on("telegram", "@danl"),
      }),
      row({
        id: "ana",
        displayName: "Ana Ruiz",
        level: "acquaintance",
        kind: "account",
        // Synced from an address book and never messaged. The directory holds
        // nobody back, and its row says the same thing about them it says about
        // everyone: who they are, and where to reach them.
        accounts: on("whatsapp", "34600555321@s.whatsapp.net"),
      }),
    ],
  },
];

/** The management view: everyone grouped by bond with live totals, three
 *  columns, no channel badges. Clicking the avatar selects. */
export function DirectoryDemo() {
  const { t } = useTranslation("people");
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Frame label="Directory" grouped>
      {DIRECTORY.map((group) => (
        <div key={group.level} className="mb-2 last:mb-0">
          <div className="flex items-baseline gap-2 px-2 py-1">
            <span className="text-ui text-foreground">{t(levelLabelKey(group.level))}</span>
            <span className="font-mono text-badge tabular-nums text-subtle-foreground">
              {group.total}
            </span>
          </div>
          <List>
            {group.rows.map((subject) => (
              <DirectoryRow
                key={subject.id}
                row={subject}
                selected={selected.includes(subject.id)}
                onOpen={() => {}}
                onToggleSelect={() =>
                  setSelected((prev) =>
                    prev.includes(subject.id)
                      ? prev.filter((id) => id !== subject.id)
                      : [...prev, subject.id],
                  )
                }
                actions={<RowMenu row={subject} />}
              />
            ))}
          </List>
        </div>
      ))}
      {/* The bulk bar is still ahead: one choice applied to every selected
          row, so its targets are the intersection across them — and N writes
          behind one confirmation, which no single verb answers. */}
      {selected.length > 0 && (
        <div className="mt-2 flex items-center justify-between rounded-8 bg-primary/10 px-3 py-2">
          <span className="text-aux text-foreground">
            {selected.length} {t("bulk.selected")}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary">
              {t("bulk.moveTo")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              {t("bulk.clear")}
            </Button>
          </span>
        </div>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------ filter chips */

/** The bond filter: the kit's radiogroup, not styled buttons. The chips are the
 *  page's own set, in its own order. */
export function FilterChipsDemo() {
  const { t } = useTranslation("people");
  const [chip, setChip] = useState("all");
  return (
    <div className="flex flex-col gap-3 rounded-12 border border-border bg-surface p-4">
      <FilterChipGroup
        aria-label={t("filters.groupLabel")}
        value={chip}
        onValueChange={setChip}
        options={FILTER_ORDER.map((option) => ({
          value: option,
          label: option === "all" ? t("filters.all") : t(levelLabelKey(option)),
          count: option === "stranger" ? 6 : undefined,
        }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------ person page */

/** The dossier: the person card with bond select and linked-account pills, one
 *  account's timeline grouped by day, a sticky composer. */
export function PersonPageDemo() {
  const { t } = useTranslation("people");
  return (
    <Frame label="/people/person/:personId">
      <div className="flex flex-col gap-4 p-2">
        <div className="flex items-start gap-3">
          <Avatar name="Mira Okafor" size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-title text-foreground">Mira Okafor</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-muted-foreground">
                <ChannelGlyph channel="whatsapp" />
                +1 206 555 0113
              </Badge>
              <Badge variant="outline" className="font-mono text-muted-foreground">
                <ChannelGlyph channel="telegram" />
                @mira
              </Badge>
              <Button size="sm" variant="ghost">
                {t("detail.linkAccount")}
              </Button>
              <Button size="sm" variant="ghost">
                {t("actions.mergeInto")}
              </Button>
            </div>
          </div>
          <Select defaultValue="inner-circle">
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["inner-circle", "acquaintance", "other", "dismissed"] as RowLevel[]).map(
                (level) => (
                  <SelectItem key={level} value={level}>
                    {t(levelLabelKey(level))}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
          <div className="text-center text-badge text-subtle-foreground">{t("timeline.today")}</div>
          {[
            { text: "landed, heading to the hotel now", at: "09:14", out: false },
            { text: "perfect — dinner at 7?", at: "09:16", out: true },
            { text: "yes, book it", at: "09:31", out: false },
          ].map((msg) => (
            <div key={msg.at} className="flex gap-2 text-ui">
              <span className="w-12 shrink-0 font-mono text-badge tabular-nums text-subtle-foreground">
                {msg.at}
              </span>
              <span className="min-w-0">
                {msg.out && (
                  <span className="text-muted-foreground">{t("detail.outboundPrefix")} </span>
                )}
                <span className="text-foreground">{msg.text}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle pt-3">
          <input
            readOnly
            placeholder={t("detail.composerPlaceholder", { name: "Mira" })}
            className="h-9 flex-1 rounded-8 border border-border bg-background px-3 text-ui text-foreground placeholder:text-subtle-foreground"
          />
          <Button size="sm">{t("whatsapp.send")}</Button>
        </div>
      </div>
    </Frame>
  );
}

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import {
  accountRef,
  ASSIGNABLE_BOND_LEVELS,
  formatWhatsAppPhone,
  normalizeBondLevel,
  personMatchesQuery,
  type AssignableBondLevel,
  type DirectoryAccount,
  type LinkConflict,
  type PersonResource,
} from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePeople } from "@/hooks/use-people";
import { getFileBrowserUrlPath } from "@/lib/file-browser-routing";
import { ChannelPill } from "./channel-meta";
import { MutationError } from "./triage";
import { levelLabelKey } from "./rows";
import { TransferConfirm } from "./transfer";
import { useAccountSearch } from "./use-roster";
import { usePeopleWrites } from "./use-writes";

// The dossier's management gestures: the bond, the accounts that resolve to
// this person, and absorbing a duplicate. Three verbs of the /people contract
// (`./writes.ts`), each settling the reads rather than editing them.
//
// The pickers offer more than what would succeed. An account another person
// holds is offerable, because taking one back is a gesture the guardian has and
// the contract answers the attempt with a conflict naming the holder — which is
// the whole reason a transfer can be explicit rather than silent.

/** The identifier a picker row is recognized by. */
function handleOf(account: { channel: string; channelUserId: string }): string {
  return account.channel === "whatsapp"
    ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
    : account.channelUserId;
}

/**
 * The card's menu: the bond, the two pickers, and whatever the last write said.
 *
 * One ⋯ menu rather than controls laid on the card. The bond is a fact the
 * header states beside the name, and changing it is a gesture like the other
 * two, so it lives with them — as a submenu of levels, the current one marked.
 *
 * The guardian's bond does not move — the contract refuses it — so their card
 * offers no menu at all: the badge reads the level and nothing changes it.
 */
export function PersonManagement({
  person,
  onMerged,
}: {
  person: PersonResource;
  /** Where to go once this person has been absorbed: they no longer exist. */
  onMerged: (survivorId: string) => void;
}) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const level = normalizeBondLevel(person.bondLevel);
  const [picker, setPicker] = useState<"link" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingBond, setSavingBond] = useState(false);

  async function handleBond(next: string) {
    setSavingBond(true);
    setError(null);
    try {
      const result = await writes.setBond(person.id, next as AssignableBondLevel);
      if (!result.ok) setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setSavingBond(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      {level !== "guardian" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* A `Button` rather than `IconButton` for the `ghost` aria-expanded
                paint, as on the directory's rows. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={savingBond}
              aria-label={t("actions.rowMenu", { name: person.displayName })}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("detail.changeBond")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={level}
                  onValueChange={(next) => void handleBond(next)}
                >
                  {ASSIGNABLE_BOND_LEVELS.map((value) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {t(levelLabelKey(value))}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPicker("link")}>
              {t("detail.linkAccount")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPicker("merge")}>
              {t("actions.mergeInto")}
            </DropdownMenuItem>
            {person.memoryPath && (
              <>
                <DropdownMenuSeparator />
                {/* Leaves for Memory rather than rendering the profile here: it
                    is a file the guardian edits, and the editor, the history and
                    the sync state are all there. Offered only when the read
                    names one — nothing writes a profile when a person is
                    created, so an item on every person would usually open
                    nothing. */}
                <DropdownMenuItem asChild>
                  <Link to={getFileBrowserUrlPath("memory", person.memoryPath)}>
                    {t("detail.memoryProfile")}
                  </Link>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <MutationError message={error} />

      {picker === "link" && <LinkAccountPicker person={person} onClose={() => setPicker(null)} />}
      {picker === "merge" && (
        <MergePicker person={person} onClose={() => setPicker(null)} onMerged={onMerged} />
      )}
    </div>
  );
}

/**
 * Pick an account to resolve to this person.
 *
 * The search is the server's, because the directory is a synced address book
 * rather than a curated listing: a filter over whichever page arrived would
 * answer "no such account" for a contact the mirror holds.
 */
function LinkAccountPicker({ person, onClose }: { person: PersonResource; onClose: () => void }) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<LinkConflict | null>(null);
  const directory = useAccountSearch(search, { enabled: true });

  const held = new Set(person.accounts.map((account) => accountRef(account)));
  const candidates = (directory.data?.accounts ?? []).filter(
    (account) => !held.has(accountRef(account)),
  );

  async function link(account: DirectoryAccount, transferFrom?: string) {
    // The transfer confirm is disabled while `busy`, and this refuses re-entry
    // besides: a disabled button depends on the render having flushed, and a
    // second transfer would re-attribute the account's history all over again.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await writes.link(person.id, account, transferFrom);
      if (result.ok) {
        setTransfer(null);
        onClose();
        return;
      }
      if ("conflict" in result && result.conflict.linkedPersonId) {
        setTransfer(result.conflict);
        return;
      }
      setTransfer(null);
      setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Wider than the merge picker: four columns of account identity, and a
          handle is as long as the channel makes it. */}
      <Dialog open onClose={onClose} size="lg" ariaLabel={t("detail.linkAccount")}>
        <DialogHeader onClose={onClose} closeLabel={t("actions.close")}>
          <DialogTitle>{t("detail.linkAccount")}</DialogTitle>
          <DialogDescription>{t("detail.linkDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t("search.label")}
            placeholder={t("search.placeholder")}
          />
          {candidates.length === 0 ? (
            <p className="py-6 text-center text-aux text-subtle-foreground">
              {directory.isPending ? t("page.loading") : t("page.emptyForSearch")}
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("linkPicker.columns.channel")}</TableHead>
                    <TableHead>{t("linkPicker.columns.name")}</TableHead>
                    <TableHead>{t("linkPicker.columns.handle")}</TableHead>
                    {/* Whose it is right now, so picking one already held is a
                        decision rather than a surprise. */}
                    <TableHead>{t("linkPicker.columns.heldBy")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.map((account) => (
                    <TableRow
                      key={accountRef(account)}
                      className="cursor-pointer"
                      onClick={() => void link(account)}
                    >
                      <TableCell>
                        <ChannelPill channel={account.channel} />
                      </TableCell>
                      <TableCell className="w-full max-w-0 text-foreground">
                        {/* The row is the hit area, and this is the same gesture
                            for the keyboard — so one press must not arrive as
                            two writes. */}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void link(account);
                          }}
                          className="block max-w-full truncate text-left outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {account.displayName}
                        </button>
                      </TableCell>
                      <TableCell className="max-w-64 truncate font-mono tabular-nums text-aux text-muted-foreground">
                        {handleOf(account)}
                      </TableCell>
                      <TableCell className="max-w-40 truncate text-aux text-muted-foreground">
                        {account.personName}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <MutationError message={error} />
        </DialogBody>
      </Dialog>
      {transfer && (
        <TransferConfirm
          conflict={transfer}
          busy={busy}
          onCancel={() => setTransfer(null)}
          onConfirm={() => {
            const account = candidates.find(
              (candidate) =>
                candidate.channel === transfer.channel &&
                candidate.channelUserId === transfer.channelUserId,
            );
            if (account) void link(account, transfer.linkedPersonId ?? undefined);
          }}
        />
      )}
    </>
  );
}

/**
 * Pick the person this one is a duplicate of.
 *
 * This person is absorbed into the pick, so the page open when the merge lands
 * is the one that goes away — the caller is handed the survivor to navigate to.
 * The listing is curated and bounded, so the search runs over what it returned.
 */
function MergePicker({
  person,
  onClose,
  onMerged,
}: {
  person: PersonResource;
  onClose: () => void;
  onMerged: (survivorId: string) => void;
}) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const people = usePeople();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      (people.data ?? []).filter(
        (candidate) =>
          candidate.id !== person.id &&
          normalizeBondLevel(candidate.bondLevel) !== "guardian" &&
          personMatchesQuery(candidate, search),
      ),
    [people.data, person.id, search],
  );

  async function merge(into: PersonResource) {
    setBusy(true);
    setError(null);
    try {
      const result = await writes.merge(into.id, person.id);
      if (!result.ok) {
        setError("conflict" in result ? result.conflict.error : result.message);
        return;
      }
      onClose();
      onMerged(into.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} size="md" ariaLabel={t("merge.title")}>
      <DialogHeader onClose={onClose} closeLabel={t("actions.close")}>
        <DialogTitle>{t("merge.title")}</DialogTitle>
        <DialogDescription>{t("merge.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("merge.selectLabel")}
          placeholder={t("merge.searchPlaceholder")}
        />
        {candidates.length === 0 ? (
          <p className="py-6 text-center text-aux text-subtle-foreground">
            {t("merge.noCandidates")}
          </p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void merge(candidate)}
                  className="flex w-full items-center gap-3 border-b border-border-subtle px-2 py-2 text-left last:border-b-0 hover:bg-surface"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-foreground">
                      {candidate.displayName}
                    </span>
                    <span className="block truncate text-aux text-muted-foreground">
                      {t(levelLabelKey(normalizeBondLevel(candidate.bondLevel)))}
                      {candidate.accounts.length > 0 &&
                        ` · ${candidate.accounts.map(handleOf).join(", ")}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <MutationError message={error} />
      </DialogBody>
    </Dialog>
  );
}

import { useId, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import {
  ASSIGNABLE_BOND_LEVELS,
  normalizeBondLevel,
  type AssignableBondLevel,
  type LinkConflict,
  type PersonResource,
} from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { cn } from "@/lib/utils";
import { DirectoryRow, UnknownRow } from "./rows";
import { levelLabelKey } from "./rows";
import { TransferConfirm } from "./transfer";
import { usePeopleWrites } from "./use-writes";
import type { LinkTarget, PeopleRow, PeopleView } from "./people-model";

// Placing an account that nobody has decided about, and taking one back.
//
// What the union page called one "move" is several verbs of the /people
// contract (`./writes.ts`), because they are several different writes: placing
// a sender creates a person or links onto one, dismissing it is a decision
// about the account, and the dismissed end of the ladder has a way back.
// Dismissal is a state an account is in rather than a merge into a sentinel, so
// there is no target list to enumerate and nothing here has to know which moves
// a row admits.
//
// A gesture names the account by the pair the contract names it with,
// never by one of the addresses it answers to: the server folds a WhatsApp
// contact's phone jid and `@lid` jid into one account, so one call already
// covers every address the row stands for.

/**
 * A submit label that swaps to a busy phrasing while the request is in flight.
 *
 * Both strings share one grid cell, so the box is always as wide as the longer
 * of the two and the swap never resizes the button. The inactive one is
 * `invisible` (which browsers already drop from the accessibility tree) *and*
 * `aria-hidden`, because jsdom computes accessible names without layout —
 * without the attribute a test would read both labels concatenated.
 */
export function BusyLabel({ idle, busy, isBusy }: { idle: string; busy: string; isBusy: boolean }) {
  return (
    <span className="grid place-items-center">
      <span className={cn("col-start-1 row-start-1", isBusy && "invisible")} aria-hidden={isBusy}>
        {idle}
      </span>
      <span className={cn("col-start-1 row-start-1", !isBusy && "invisible")} aria-hidden={!isBusy}>
        {busy}
      </span>
    </span>
  );
}

/** Why the last write failed, sitting at the left end of a button row. */
export function MutationError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mr-auto text-aux text-destructive-fg">
      {message}
    </p>
  );
}

function CreateProfileForm({
  defaultName,
  error,
  onSubmit,
  onCancel,
}: {
  /** What the account's own platform calls it — the name a person is most
   *  likely to be created under, and never a linked person's. */
  defaultName: string;
  error: string | null;
  onSubmit: (data: { displayName: string; bondLevel: AssignableBondLevel }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("people");
  const uid = useId();
  const form = useForm({
    defaultValues: { displayName: defaultName, bondLevel: "acquaintance" as AssignableBondLevel },
    onSubmit: async ({ value }) => {
      await onSubmit({ displayName: value.displayName, bondLevel: value.bondLevel });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="mb-2 space-y-3 rounded-8 border border-border-subtle bg-surface-muted/60 p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <form.Field name="displayName">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${uid}-display-name`}>{t("createForm.nameLabel")}</FieldLabel>
              <Input
                id={`${uid}-display-name`}
                type="text"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                required
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="bondLevel">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${uid}-bond-level`}>
                {t("createForm.bondLevelLabel")}
              </FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value as AssignableBondLevel)}
              >
                <SelectTrigger id={`${uid}-bond-level`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_BOND_LEVELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(levelLabelKey(value))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      </div>
      <form.Subscribe<{ isSubmitting: boolean; displayName: string }>
        selector={(s) => ({ isSubmitting: s.isSubmitting, displayName: s.values.displayName })}
      >
        {({ isSubmitting, displayName }) => (
          <div className="flex items-center justify-end gap-2">
            <MutationError message={error} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting || !displayName}>
              <BusyLabel
                idle={t("actions.createProfile")}
                busy={t("actions.creating")}
                isBusy={isSubmitting}
              />
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

function LinkForm({
  people,
  recommendations,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  people: LinkTarget[];
  /**
   * The people whose name is this account's, exactly — offered first as
   * one-click links. Every one of them is also in `people`, so the picker
   * below can still reach any of them; these only save the search. Empty when
   * nothing matches, and then the form is the picker it always was.
   */
  recommendations: LinkTarget[];
  /** A link the parent is already running (a recommended one, or a transfer),
   *  which the quick-link buttons outside the form's own submit state read to
   *  hold still. */
  busy: boolean;
  error: string | null;
  onSubmit: (personId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("people");
  const uid = useId();
  const form = useForm({
    defaultValues: { selectedId: "" },
    onSubmit: async ({ value }) => {
      if (!value.selectedId) return;
      await onSubmit(value.selectedId);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="mb-2 space-y-3 rounded-8 border border-border-subtle bg-surface-muted/60 p-3"
    >
      {recommendations.length > 0 && (
        // The exact-name matches, above the picker and never in place of it.
        // Each is a link the guardian can take in one click, but Rome takes
        // none on its own — the button is the explicit link action, the same
        // write the picker's own submit makes. Several names that fold the same
        // are all here, none of them chosen.
        <div className="space-y-1">
          <p className="text-aux text-muted-foreground">
            {t("linkForm.recommendedLabel", { count: recommendations.length })}
          </p>
          <div className="flex flex-col gap-1">
            {recommendations.map((person) => (
              <Button
                key={person.id}
                type="button"
                variant="outline"
                size="sm"
                className="justify-start"
                disabled={busy}
                onClick={() => void onSubmit(person.id)}
              >
                {person.displayName} · {t(levelLabelKey(normalizeBondLevel(person.bondLevel)))}
              </Button>
            ))}
          </div>
        </div>
      )}
      <form.Field name="selectedId">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={`${uid}-person`}>{t("linkForm.label")}</FieldLabel>
            <Select value={field.state.value || undefined} onValueChange={field.handleChange}>
              <SelectTrigger id={`${uid}-person`} className="w-full">
                <SelectValue placeholder={t("linkForm.selectPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {people.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.displayName} · {t(levelLabelKey(normalizeBondLevel(person.bondLevel)))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Subscribe<{ isSubmitting: boolean; selectedId: string }>
        selector={(s) => ({ isSubmitting: s.isSubmitting, selectedId: s.values.selectedId })}
      >
        {({ isSubmitting, selectedId }) => (
          <div className="flex items-center justify-end gap-2">
            <MutationError message={error} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting || !selectedId}>
              <BusyLabel
                idle={t("actions.linkSubmit")}
                busy={t("actions.linking")}
                isBusy={isSubmitting}
              />
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

/**
 * The row an entry's gestures sit on, which is the view's own answer.
 *
 * The stream's row is dense: a placement decision runs on the evidence — which
 * channel, which number, what they last said — so all of it is on the row. The
 * directory carries none of that, so its row is the contacts line every other
 * row in that view is, and the gestures sit behind a `⋯` menu at the end of it.
 */
function entryRow(variant: PeopleView) {
  return variant === "directory" ? DirectoryRow : UnknownRow;
}

/**
 * One unplaced account, with the gestures that place it.
 *
 * Nothing is handed back to a parent to refresh: every verb here settles by
 * invalidating the reads and resolves once they have landed, so the row stands
 * until the listing that no longer holds it has arrived.
 */
export function UnknownEntry({
  row,
  people,
  recommendations,
  variant,
}: {
  row: PeopleRow;
  /** The people a link can land on — the listing's own rows. */
  people: LinkTarget[];
  /**
   * The eligible people whose name is this account's, exactly. Offered as the
   * link action's named target and as one-click links inside the form, never
   * as a decision Rome makes for the guardian. Empty when nothing matches, and
   * then the link action is the plain one it always was.
   */
  recommendations: LinkTarget[];
  /** Which view this row is in — see {@link entryRow}. */
  variant: PeopleView;
}) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [action, setAction] = useState<"create" | "link" | null>(null);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  // A refused link, with the person it would be taken from. Held rather than
  // acted on: the transfer is a second thing to ask for.
  const [transfer, setTransfer] = useState<{ conflict: LinkConflict; personId: string } | null>(
    null,
  );
  const account = row.accounts[0];
  const name = row.displayName || account?.channelUserId || "";

  // The link action names its recommendation when there is one: a single exact
  // match names that person, several name their count, and none leaves the
  // plain "Link". Every one opens the same form and the same full picker — the
  // label only says whether an exact name-match was already found to start
  // from, never that Rome has chosen or linked anyone.
  const linkLabel =
    recommendations.length === 1
      ? t("actions.linkTo", { name: recommendations[0]?.displayName ?? "" })
      : recommendations.length > 1
        ? t("actions.linkSuggested", { count: recommendations.length })
        : null;

  /** Opening, switching or cancelling a form drops the previous failure. */
  function openAction(next: "create" | "link" | null) {
    setError(null);
    setAction(next);
  }

  async function handleCreate(data: { displayName: string; bondLevel: AssignableBondLevel }) {
    if (!account) return;
    setError(null);
    const result = await writes.place(account, data);
    if (result.ok) {
      setAction(null);
      return;
    }
    // A create cannot transfer — the contract has no `transferFrom` on it — so
    // a held account is reported in the words the route refused in, and the
    // guardian links onto the holder instead.
    setError("conflict" in result ? result.conflict.error : result.message);
  }

  async function handleLink(personId: string, transferFrom?: string) {
    if (!account) return;
    // The transfer confirm stays on screen until this settles — the write is
    // what closes it — so the link has to hold the row busy rather than lean on
    // the form's own submit state, which the confirm does not have. A second
    // transfer would re-attribute the account's history again, and would arrive
    // naming an owner the first one has already replaced: it refuses, and
    // reports a conflict against the person the guardian just moved it to.
    if (acting) return;
    setActing(true);
    setError(null);
    try {
      const result = await writes.link(personId, account, transferFrom);
      if (result.ok) {
        setTransfer(null);
        setAction(null);
        return;
      }
      if ("conflict" in result && result.conflict.linkedPersonId) {
        setTransfer({ conflict: result.conflict, personId });
        return;
      }
      setTransfer(null);
      setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setActing(false);
    }
  }

  async function handleDismiss() {
    if (!account) return;
    // The row's own trigger names the running operation, so the dialog steps out
    // of the way the moment the write starts rather than sitting there disabled
    // with nothing to say.
    setConfirmingDismiss(false);
    setActing(true);
    setError(null);
    try {
      const result = await writes.dismiss(account);
      // A write that didn't land leaves the account exactly where it was. Say
      // so — closing the dialog silently reads as success, which is the
      // opposite of what this confirmation exists to do.
      if (!result.ok) setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setActing(false);
    }
  }

  const Row = entryRow(variant);
  // The verbs wear the shape their view has room for. The stream is the triage
  // surface, a handful of senders waiting on a decision, so its dense row
  // carries the three as buttons. The directory's Unknown group is everyone
  // Rome has not placed — a synced address book can put hundreds of rows in it
  // — and three buttons per contact would out-shout the roster the view exists
  // to read, so there they fold into one quiet row menu.
  const triageButtons = (
    <span className="flex items-center gap-1">
      <Button type="button" size="sm" onClick={() => openAction("create")} disabled={acting}>
        {t("actions.create")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openAction("link")}
        disabled={acting}
      >
        {linkLabel ?? t("actions.link")}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setConfirmingDismiss(true)}
        disabled={acting}
      >
        <BusyLabel
          idle={t("actions.markStranger")}
          busy={t("actions.markingStranger")}
          isBusy={acting}
        />
      </Button>
    </span>
  );
  const rowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A `Button` rather than `IconButton` for the `ghost` aria-expanded
            paint, which marks the row whose menu is open. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={acting}
          aria-label={t("actions.rowMenu", { name })}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openAction("create")}>
          {t("placeMenu.create")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openAction("link")}>
          {linkLabel ?? t("placeMenu.link")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Deliberately the same words as the confirm dialog's button: the item
            that opens the confirm and the button that carries it out promise
            the same thing. */}
        <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDismiss(true)}>
          {t("actions.markStranger")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <div>
      <Row row={row} actions={!action && (variant === "directory" ? rowMenu : triageButtons)} />

      {/* With no form open the failure belongs to the dismissal, whose button
          sits on the row above. */}
      {!action && error && (
        <div className="flex justify-end px-3 pb-2">
          <MutationError message={error} />
        </div>
      )}

      {action === "create" && (
        <CreateProfileForm
          defaultName={row.displayName}
          error={error}
          onSubmit={handleCreate}
          onCancel={() => openAction(null)}
        />
      )}
      {action === "link" && (
        <LinkForm
          people={people}
          recommendations={recommendations}
          busy={acting}
          error={error}
          onSubmit={(personId) => handleLink(personId)}
          onCancel={() => openAction(null)}
        />
      )}

      <RomeConfirmDialog
        open={confirmingDismiss}
        destructive
        title={t("strangerConfirm.title", { name })}
        // A dismissal does not take the account off the directory — it moves it
        // to the Stranger end of the ladder, which has a chip of its own — so
        // the copy names the listing it leaves.
        description={t("strangerConfirm.description", {
          name,
          section: t("levels.unknown"),
        })}
        // Deliberately the same words as the trigger: the button that opens the
        // confirm and the button that carries it out promise the same thing.
        confirmLabel={t("actions.markStranger")}
        cancelLabel={t("actions.cancel")}
        onCancel={() => setConfirmingDismiss(false)}
        onConfirm={() => void handleDismiss()}
      />

      {transfer && (
        <TransferConfirm
          conflict={transfer.conflict}
          busy={acting}
          onCancel={() => setTransfer(null)}
          onConfirm={() =>
            void handleLink(transfer.personId, transfer.conflict.linkedPersonId ?? undefined)
          }
        />
      )}
    </div>
  );
}

/**
 * An account the guardian dismissed, with the gesture that undoes it.
 *
 * The same row the Unknown view uses in whichever view it is in, because the
 * decision runs on the same evidence. No confirmation — a restore only puts the
 * account back where a decision is still owed.
 */
export function DismissedEntry({ row, variant }: { row: PeopleRow; variant: PeopleView }) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = row.accounts[0];

  async function handleRestore() {
    if (!account) return;
    setActing(true);
    setError(null);
    try {
      const result = await writes.restore(account);
      if (!result.ok) setError("conflict" in result ? result.conflict.error : result.message);
    } finally {
      setActing(false);
    }
  }

  const Row = entryRow(variant);
  return (
    <div>
      <Row
        row={row}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={acting}
            onClick={() => void handleRestore()}
          >
            <BusyLabel idle={t("actions.restore")} busy={t("actions.restoring")} isBusy={acting} />
          </Button>
        }
      />
      {error && (
        <div className="flex justify-end px-3 pb-2">
          <MutationError message={error} />
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, SendHorizontal } from "lucide-react";
import { canSend, type LinkedAccount, type PersonResource } from "@rome/api-types/people";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PAGE_FLOOR } from "@/shell/PageShell";
import { ChannelGlyph, channelLabel } from "./channel-meta";
import { sendRefusalKey, type RefusedSendState } from "./send-copy";
import { accountHandle } from "./send-model";
import { usePeopleWrites } from "./use-writes";

/**
 * The composer: one message, to one account the guardian can see it is going
 * to.
 *
 * The target is always on screen before Send is pressed. That is the contract's
 * rule rather than a layout choice — a send names its account and nothing infers
 * one, so a surface offering a preselected account has to show which one it
 * picked. `defaultSendAccount` decides the preselection, and it is the
 * contract's function rather than a rule restated here.
 *
 * The target takes its own line above the box, as a chip after "To". A chip
 * beside the box cost it a third of the row for a label that is read once and
 * typed past; on its own line it can carry the whole name and leave the box the
 * full width, at every card width, with no stacking rule to switch.
 *
 * The picker appears only in the merged view, and only when more than one
 * account can be written to. Inside an account view the view is the target, so a
 * second choice would be asking the guardian to say the same thing twice.
 *
 * An account that cannot be written to shows why instead of a text box. The
 * reason is the state the server declared, rendered through `./send-copy.ts` —
 * no sentence crosses the wire, so every locale reads the same way.
 */
export function Composer({
  person,
  target,
  onChangeTarget,
}: {
  person: PersonResource;
  /** The account this composer writes to, or null when the person holds none
   *  at all. */
  target: LinkedAccount | null;
  /** Offered where there is something to pick: the merged view. Null inside an
   *  account view, where the view already names the target. */
  onChangeTarget: ((account: LinkedAccount) => void) | null;
}) {
  const { t } = useTranslation("people");
  const writes = usePeopleWrites();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // How the last send went, and which account it was addressed to.
  //
  // The account is carried so the line can be shown only while it is still
  // about the target on screen. A refusal names a channel, so one left standing
  // after the guardian switches accounts is not merely stale — it describes a
  // channel that is no longer the one being written to, which is worse than
  // showing nothing. Held together and compared at render rather than cleared
  // by an effect, so there is no ordering in which the wrong pair can be shown.
  const [attempt, setAttempt] = useState<{
    account: { channel: string; channelUserId: string };
    refusal: RefusedSendState | null;
    message: string | null;
  } | null>(null);

  // Nothing at all for a person Rome holds no address for. The dossier header
  // already says they have no accounts, and this slot is for a channel giving a
  // reason — an absent account is not a channel refusing.
  if (target === null) {
    if (person.accounts.length === 0) return null;
    // Every reason, not a summary of them. Declaring sendability per account is
    // what the person read went and fetched; spending it on one flat "cannot
    // send" would waste the only thing it got.
    const reasons = [
      ...new Set(
        person.accounts.flatMap((account) =>
          account.send === "yes" ? [] : [refusalText(t, account.send, account.channel)],
        ),
      ),
    ];
    return <Note>{reasons.join(" ")}</Note>;
  }

  // An account view still opens on a target that cannot be written to: its
  // history is readable, and the reason takes the text box's place.
  if (target.send !== "yes") {
    return <Note>{refusalText(t, target.send, target.channel)}</Note>;
  }

  const options = person.accounts.filter(canSend);
  const text = draft.trim();
  // Shown only while it still describes the account being written to. A switch
  // of target retires it without anything having to remember to.
  const failed =
    attempt &&
    attempt.account.channel === target.channel &&
    attempt.account.channelUserId === target.channelUserId
      ? attempt
      : null;

  async function submit() {
    // `target` is narrowed above; the closure is re-created every render, so it
    // is the account rendered beside the box and not an earlier one.
    if (target === null || text === "" || sending) return;
    const account = { channel: target.channel, channelUserId: target.channelUserId };
    setSending(true);
    setAttempt(null);
    const outcome = await writes.say(person.id, target, text);
    setSending(false);
    if (outcome.ok) {
      setDraft("");
      return;
    }
    // A 409 raced a disconnect: the account was sendable when the page read it
    // and is not now. It renders as the line the composer would have shown had
    // the read been fresh, which is what carrying the state rather than a
    // sentence buys.
    setAttempt(
      "conflict" in outcome
        ? { account, refusal: outcome.conflict.send, message: null }
        : { account, refusal: null, message: outcome.message },
    );
  }

  return (
    <Floor>
      <p className="mb-2 flex items-center gap-2 text-aux text-muted-foreground">
        <span>{t("send.to")}</span>
        {onChangeTarget && options.length > 1 ? (
          <TargetMenu options={options} value={target} onChange={onChangeTarget} />
        ) : (
          <TargetChip account={target} />
        )}
      </p>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t("detail.composerPlaceholder", { name: person.displayName })}
          aria-label={t("detail.composerLabel")}
        />
        <Button
          type="button"
          size="sm"
          disabled={text === "" || sending}
          onClick={() => void submit()}
        >
          <SendHorizontal aria-hidden="true" />
          {t("send.submit")}
        </Button>
      </div>
      {failed && (
        <p className="mt-2 text-aux text-destructive">
          {failed.refusal ? refusalText(t, failed.refusal, failed.account.channel) : failed.message}
        </p>
      )}
    </Floor>
  );
}

/** The reason, in this locale's words: the server names which refusal it is and
 *  the dashboard owns every sentence. */
function refusalText(
  t: ReturnType<typeof useTranslation<"people">>["t"],
  send: RefusedSendState,
  channel: string,
): string {
  return t(sendRefusalKey(send, channel), { channel: channelLabel(t, channel) });
}

/** One chip's worth of target: the channel's glyph and name, and the handle.
 *  A `Badge`, so the chip's box comes from the badge tokens. */
function TargetChip({ account }: { account: LinkedAccount }) {
  const { t } = useTranslation("people");
  return (
    <Badge variant="muted" className="min-w-0">
      <ChannelGlyph channel={account.channel} />
      <span className="truncate">
        {channelLabel(t, account.channel)} · {accountHandle(account)}
      </span>
    </Badge>
  );
}

/** The target, visible at rest and one click from being changed. */
function TargetMenu({
  options,
  value,
  onChange,
}: {
  options: LinkedAccount[];
  value: LinkedAccount;
  onChange: (account: LinkedAccount) => void;
}) {
  const { t } = useTranslation("people");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge variant="muted" asChild>
          <button
            type="button"
            className="min-w-0 cursor-pointer outline-none transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring aria-expanded:text-foreground"
          >
            <ChannelGlyph channel={value.channel} />
            <span className="truncate">
              {channelLabel(t, value.channel)} · {accountHandle(value)}
            </span>
            <ChevronDown aria-hidden="true" />
          </button>
        </Badge>
      </DropdownMenuTrigger>
      {/* Opens upward: the chip sits on a floor pinned to the bottom of the
          viewport, so below it there is nothing but the edge. */}
      <DropdownMenuContent align="start" side="top">
        {options.map((account) => (
          <DropdownMenuItem
            key={`${account.channel}:${account.channelUserId}`}
            onSelect={() => onChange(account)}
          >
            <ChannelGlyph channel={account.channel} />
            <span>{channelLabel(t, account.channel)}</span>
            <span className="font-mono text-badge text-subtle-foreground">
              {accountHandle(account)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Floor>
      <p className="text-aux text-muted-foreground">{children}</p>
    </Floor>
  );
}

/**
 * The slot the composer sits in: a card floating over the bottom of the
 * viewport.
 *
 * The timeline above it is as long as the history, so on any page that does
 * not fit, the box would otherwise be below the fold: the reader scrolls to
 * find it, and it moves every time older rows arrive. Sticky keeps it at the
 * bottom edge while the section runs past, and `mt-auto` puts it there too
 * when the section is shorter than the viewport, so there is one place it is.
 * Both the text box and the refusal that takes its place render here, so the
 * slot holds still across the two.
 *
 * A raised surface rather than a footer band, the same floor the chat
 * composer rides: rows scroll under a translucent card instead of stopping at
 * a solid edge. The outer slot lets pointer events through so the rows
 * showing between the card and the viewport's edge stay clickable.
 */
function Floor({ children }: { children: React.ReactNode }) {
  return (
    <div className={`pointer-events-none sticky bottom-0 z-10 mt-auto pt-4 ${PAGE_FLOOR}`}>
      <div className="pointer-events-auto rounded-16 border border-border bg-surface/95 p-3 shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80">
        {children}
      </div>
    </div>
  );
}

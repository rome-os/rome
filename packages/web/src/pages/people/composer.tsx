import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, SendHorizontal } from "lucide-react";
import { canSend, type LinkedAccount, type PersonResource } from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
  const [refusal, setRefusal] = useState<{ send: RefusedSendState; channel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function submit() {
    // `target` is narrowed above; the closure is re-created every render, so it
    // is the account rendered beside the box and not an earlier one.
    if (target === null || text === "" || sending) return;
    setSending(true);
    setRefusal(null);
    setError(null);
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
    if ("conflict" in outcome) setRefusal({ send: outcome.conflict.send, channel: target.channel });
    else setError(outcome.message);
  }

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        {onChangeTarget && options.length > 1 ? (
          <TargetMenu options={options} value={target} onChange={onChangeTarget} />
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded-8 bg-surface-muted px-2 py-1 text-badge text-muted-foreground">
            <ChannelGlyph channel={target.channel} />
            {channelLabel(t, target.channel)} · {accountHandle(target)}
          </span>
        )}
        <Input
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
      {refusal && (
        <p className="mt-2 text-aux text-destructive">
          {refusalText(t, refusal.send, refusal.channel)}
        </p>
      )}
      {error && <p className="mt-2 text-aux text-destructive">{error}</p>}
    </div>
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
        <Button type="button" variant="outline" size="sm" className="shrink-0">
          <ChannelGlyph channel={value.channel} />
          {channelLabel(t, value.channel)} · {accountHandle(value)}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
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
    <p className="mt-4 border-t border-border pt-3 text-aux text-muted-foreground">{children}</p>
  );
}

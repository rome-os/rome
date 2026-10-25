import { useState } from "react";
import { Link } from "react-router-dom";
import { LINKABLE_KINDS, agentLabel, canonicalAgent } from "@rome/api-types/account-agents";
import { useTranslation } from "react-i18next";
import { Bot, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { CHANNEL_CONFIGS, ChannelConnectCard } from "@/components/channels/channel-connect-card";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";

/**
 * Account controls on a channel card: "Add another account" for services that
 * offer several, and the agent of a linkable service's account whose Talk is
 * connected, with a way to Envoys to change it. Both act on the account (the card's channel), not on
 * a slot, so they sit below the slot cards. Adding opens the service's connect
 * flow for a new account, which exists only once that flow connects it.
 */

/** Whether the card's own Talk (not a folded personal-account slot) is connected. */
function talkConnected(card: ConnectionCard): boolean {
  return card.slots.some((slot) => slot.key !== "session" && slot.state !== "unauthorized");
}

export function AccountControls({
  card,
  onRefresh,
  onOpenAccount,
}: {
  card: ConnectionCard;
  onRefresh: () => void;
  /** Open another account's card by its connection id. Rejects when the
   *  account is not listed yet. Without it, the add button is hidden. */
  onOpenAccount?: (connectionId: string) => void | Promise<void>;
}) {
  // Held here so a poll that turns `showAdd` off cannot unmount a setup
  // already under way and cancel it.
  const [adding, setAdding] = useState(false);
  const connected = talkConnected(card);
  const showLink =
    card.linkReported && card.channel !== null && connected && LINKABLE_KINDS.has(card.service);
  // A second account only makes sense next to a first one that exists.
  const showAdd =
    adding || (card.severalAccounts && connected && CHANNEL_CONFIGS[card.service] !== undefined);
  if (!showLink && !(showAdd && onOpenAccount)) return null;

  const canAdd = showAdd && onOpenAccount !== undefined && addable(card);
  const showRows = showLink || (canAdd && !adding);

  return (
    <div className="space-y-4">
      {showRows && (
        <List className="overflow-hidden rounded-12 border border-border-subtle">
          {showLink && <AccountAgentRow card={card} />}
          {canAdd && !adding && <AddAccountRow onAdd={() => setAdding(true)} />}
        </List>
      )}
      {canAdd && adding && onOpenAccount && (
        <AddAccount
          card={card}
          setAdding={setAdding}
          onRefresh={onRefresh}
          onOpenAccount={onOpenAccount}
        />
      )}
    </div>
  );
}

/** Whether this service has a connect flow a new account can go through. */
function addable(card: ConnectionCard): boolean {
  return CHANNEL_CONFIGS[card.service] !== undefined && newAccountSlot(card) !== null;
}

function AddAccountRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <ListRow asChild interactive>
      <button type="button" onClick={onAdd}>
        <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <ListRowContent>{t("connections.accounts.add")}</ListRowContent>
      </button>
    </ListRow>
  );
}

/** The slot a new account of `card`'s service connects: the card's own Talk
 *  slot, with nothing connected and no connection behind it yet. */
function newAccountSlot(card: ConnectionCard): ConnectionSlot | null {
  const own = card.slots.find((slot) => slot.key !== "session");
  if (!own) return null;
  return {
    ...own,
    connectionId: null,
    state: "unauthorized",
    display: null,
    identity: null,
    activeSetupCid: null,
  };
}

function AddAccount({
  card,
  setAdding,
  onRefresh,
  onOpenAccount,
}: {
  card: ConnectionCard;
  setAdding: (adding: boolean) => void;
  onRefresh: () => void;
  onOpenAccount: (connectionId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const config = CHANNEL_CONFIGS[card.service];
  const slot = newAccountSlot(card);
  if (!config || !slot) return null;

  const opened = async (connectionId: string | null) => {
    setAdding(false);
    try {
      if (!connectionId) throw new Error("Core did not name the new account.");
      await onOpenAccount(connectionId);
    } catch {
      void onRefresh();
      // Not an error: the account is connected. The Settings tab's `onFlash`
      // shows errors, so this one goes out as a plain toast.
      toast(t("connections.accounts.addedNotShown"));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-aux text-muted-foreground">{t("connections.accounts.newAccount")}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
          {t("common.cancel")}
        </Button>
      </div>
      <ChannelConnectCard
        config={config}
        slot={slot}
        role="primary"
        another
        onRefresh={onRefresh}
        onConnected={(connectionId) => void opened(connectionId)}
      />
    </div>
  );
}

/** The account's agent, read-only. Envoys is where it changes, since that is
 *  where the confirmation and the one-account-per-platform warning live. */
function AccountAgentRow({ card }: { card: ConnectionCard }) {
  const { t } = useTranslation("settings");
  const agent = card.agent === null ? null : canonicalAgent(card.agent);
  return (
    <ListRow asChild interactive>
      <Link to={agent ? `/envoys/${encodeURIComponent(agent)}/settings` : "/envoys"}>
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <ListRowContent>
          <ListRowTitle className="truncate">
            {agent ? (
              <span className="font-mono">{agentLabel(agent)}</span>
            ) : (
              t("connections.accounts.noAgentTitle")
            )}
          </ListRowTitle>
          <ListRowDescription>
            {agent ? t("connections.accounts.agentAnswers") : t("connections.accounts.agentNone")}
          </ListRowDescription>
        </ListRowContent>
        <span className="sr-only shrink-0 text-aux text-muted-foreground sm:not-sr-only">
          {t("connections.accounts.changeInEnvoys")}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </ListRow>
  );
}

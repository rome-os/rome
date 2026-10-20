import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LINKABLE_SERVICES, MAIN_AGENT_ID } from "@rome/api-types/account-agents";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchJson } from "@/lib/fetch-json";
import { CHANNEL_CONFIGS, ChannelConnectCard } from "@/components/channels/channel-connect-card";
import { linkAccountAgent } from "@/lib/connections-api";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";

/**
 * Account controls on a channel card: "Add another account" for services that
 * offer several, and the "Agent" picker for a linkable service's account
 * whose Talk is connected. Both act on the account (the card's channel), not on
 * a slot, so they sit below the slot cards. Adding opens the service's connect
 * flow for a new account, which exists only once that flow connects it.
 */

/** Radix Select reserves the empty string, so "no agent" needs a value of its own. */
const NO_AGENT = "__none__";

const AGENTS_QUERY_KEY = ["connection-accounts", "agents"] as const;

/** `/api/agents` and the link route also know main as `main`. */
function canonicalAgent(name: string): string {
  return name === "main" ? MAIN_AGENT_ID : name;
}

function agentLabel(name: string): string {
  return name === MAIN_AGENT_ID ? "main" : name;
}

interface AgentOption {
  name: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Whether the card's own Talk (not a folded personal-account slot) is connected. */
function talkConnected(card: ConnectionCard): boolean {
  return card.slots.some((slot) => slot.key !== "session" && slot.state !== "unauthorized");
}

export function AccountControls({
  card,
  onRefresh,
  onFlash,
  onOpenAccount,
}: {
  card: ConnectionCard;
  onRefresh: () => void;
  onFlash: (message: string) => void;
  /** Open another account's card by its connection id. Rejects when the
   *  account is not listed yet. Without it, the add button is hidden. */
  onOpenAccount?: (connectionId: string) => void | Promise<void>;
}) {
  const connected = talkConnected(card);
  const showLink =
    card.linkReported && card.channel !== null && connected && LINKABLE_SERVICES.has(card.service);
  // A second account only makes sense next to a first one that exists.
  const showAdd = card.severalAccounts && connected && CHANNEL_CONFIGS[card.service] !== undefined;
  if (!showLink && !(showAdd && onOpenAccount)) return null;

  return (
    <div className="space-y-4">
      {showLink && card.channel && (
        <AccountAgentField
          card={card}
          channel={card.channel}
          onRefresh={onRefresh}
          onFlash={onFlash}
        />
      )}
      {showAdd && onOpenAccount && (
        <AddAccount card={card} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
      )}
    </div>
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
  onRefresh,
  onOpenAccount,
}: {
  card: ConnectionCard;
  onRefresh: () => void;
  onOpenAccount: (connectionId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);
  const config = CHANNEL_CONFIGS[card.service];
  const slot = newAccountSlot(card);
  if (!config || !slot) return null;

  if (!adding) {
    return (
      <Button type="button" variant="outline" onClick={() => setAdding(true)}>
        <Plus data-icon="inline-start" aria-hidden />
        {t("connections.accounts.add")}
      </Button>
    );
  }

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

function AccountAgentField({
  card,
  channel,
  onRefresh,
  onFlash,
}: {
  card: ConnectionCard;
  channel: string;
  onRefresh: () => void;
  onFlash: (message: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [saving, setSaving] = useState(false);
  // The choice the server accepted, with the link it replaced. It shows until
  // the refreshed card reports a different link, so the trigger never falls
  // back to the old link in between.
  const [pending, setPending] = useState<{ value: string; replaced: string | null } | null>(null);
  // Once the refreshed card reports another link, the server's value takes
  // over. Dropping the choice then keeps a later switch or unlink made
  // elsewhere from bringing it back.
  if (pending && pending.replaced !== card.agent) setPending(null);
  const shown = pending && pending.replaced === card.agent ? pending.value : null;
  const linked = card.agent === null ? null : canonicalAgent(card.agent);
  const current = shown ?? linked ?? NO_AGENT;
  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    // Loaded agents rarely change, so opening another account reuses the list.
    staleTime: 60_000,
    queryFn: async () => {
      const payload = await fetchJson<{ agents: AgentOption[] }>("/api/agents", {
        fallback: t("connections.accounts.agentsFailed"),
      });
      // Main links like any agent. An account with no agent stays silent.
      return [...new Set(payload.agents.map((agent) => canonicalAgent(agent.name)))];
    },
  });

  // Keep the current link selectable even when its agent is no longer loaded,
  // so the trigger shows what the server holds.
  const names = agentsQuery.data ?? [];
  const options = linked && !names.includes(linked) ? [linked, ...names] : names;

  const change = async (value: string) => {
    if (value === current) return;
    const agent = value === NO_AGENT ? null : value;
    setSaving(true);
    setPending({ value, replaced: card.agent });
    try {
      await linkAccountAgent(channel, agent, t("connections.accounts.linkFailed"));
      const account = card.label;
      // Confirmations, not errors, so they skip `onFlash`.
      if (agent === null) {
        toast(t("connections.accounts.linkCleared", { account }));
      } else {
        toast(t("connections.accounts.linked", { agent: agentLabel(agent), account }));
      }
      onRefresh();
    } catch (error) {
      setPending(null);
      onFlash(errorMessage(error, t("connections.accounts.linkFailed")));
    } finally {
      setSaving(false);
    }
  };

  const triggerId = `account-agent-${channel}`;
  return (
    <Field>
      <FieldLabel htmlFor={triggerId}>{t("connections.accounts.agent")}</FieldLabel>
      <Select value={current} onValueChange={(value) => void change(value)} disabled={saving}>
        <SelectTrigger id={triggerId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_AGENT}>{t("connections.accounts.noAgent")}</SelectItem>
          {options.map((name) => (
            <SelectItem key={name} value={name}>
              {agentLabel(name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {agentsQuery.isError ? (
        <FieldError
          errors={[errorMessage(agentsQuery.error, t("connections.accounts.agentsFailed"))]}
        />
      ) : (
        <FieldDescription>{t("connections.accounts.agentDescription")}</FieldDescription>
      )}
    </Field>
  );
}

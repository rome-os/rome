import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LINKABLE_SERVICES } from "@rome/api-types/linked-agents";
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
import { type ApiConnection, createConnection, linkAccountAgent } from "@/lib/connections-api";
import { type ConnectionCard, connectionRoute } from "@/lib/connection-cards";

/**
 * Account controls on a channel card: "Add another account" for services that
 * offer several, and the "Linked agent" picker for a linkable service's account
 * whose Talk is connected. Both act on the account (the card's channel), not on
 * a slot, so they sit below the slot cards.
 */

/** Radix Select reserves the empty string, so "no linked agent" needs a value of its own. */
const NO_AGENT = "__none__";

const AGENTS_QUERY_KEY = ["connection-accounts", "agents"] as const;

/** Main's canonical id, which the link route stores. `/api/agents` and the
 *  route also know it as `main`. Switch this and the alias handling in
 *  `channels-settings-page.tsx` to `@rome/api-types/linked-agents` together
 *  once it exports main's ids. */
const MAIN_AGENT = "core:main";

function canonicalAgent(name: string): string {
  return name === "main" ? MAIN_AGENT : name;
}

function agentLabel(name: string): string {
  return name === MAIN_AGENT ? "main" : name;
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
  /** Open another account's card by its route. Rejects when the account is
   *  not listed yet. Without it, the add button is hidden. */
  onOpenAccount?: (route: string) => void | Promise<void>;
}) {
  const connected = talkConnected(card);
  const showLink =
    card.linkReported && card.channel !== null && connected && LINKABLE_SERVICES.has(card.service);
  // A second account only makes sense next to a first one that exists.
  const showAdd = card.severalAccounts && connected;
  if (!showLink && !(showAdd && onOpenAccount)) return null;

  return (
    <div className="space-y-4">
      {showLink && card.channel && (
        <LinkedAgentField
          card={card}
          channel={card.channel}
          onRefresh={onRefresh}
          onFlash={onFlash}
        />
      )}
      {showAdd && onOpenAccount && (
        <AddAccountButton service={card.service} onFlash={onFlash} onOpenAccount={onOpenAccount} />
      )}
    </div>
  );
}

function AddAccountButton({
  service,
  onFlash,
  onOpenAccount,
}: {
  service: string;
  onFlash: (message: string) => void;
  onOpenAccount: (route: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    setAdding(true);
    try {
      const fallback = t("connections.accounts.addFailed");
      let connection: ApiConnection;
      try {
        connection = await createConnection(service, fallback);
      } catch (error) {
        onFlash(errorMessage(error, fallback));
        return;
      }
      // The account exists from here on, so a failure to open it must not read
      // as a failed add: a retry would create another one.
      try {
        // Without a channel the route would be the service, which opens the
        // first account instead of the new one.
        if (!connection.channel) throw new Error("The new account has no channel.");
        await onOpenAccount(connectionRoute(connection));
      } catch {
        // Not an error: the account exists. The Settings tab's `onFlash`
        // shows errors, so this one goes out as a plain toast.
        toast(t("connections.accounts.addedNotShown"));
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <Button type="button" variant="outline" disabled={adding} onClick={() => void add()}>
      <Plus data-icon="inline-start" aria-hidden />
      {t("connections.accounts.add")}
    </Button>
  );
}

function LinkedAgentField({
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
  // over. Dropping the choice then keeps a later move of the link from
  // bringing it back.
  if (pending && pending.replaced !== card.linkedAgent) setPending(null);
  const shown = pending && pending.replaced === card.linkedAgent ? pending.value : null;
  const linked = card.linkedAgent === null ? null : canonicalAgent(card.linkedAgent);
  const current = shown ?? linked ?? NO_AGENT;
  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    // Loaded agents rarely change, so opening another account reuses the list.
    staleTime: 60_000,
    queryFn: async () => {
      const payload = await fetchJson<{ agents: AgentOption[] }>("/api/agents", {
        fallback: t("connections.accounts.agentsFailed"),
      });
      // Main links like any agent. An account with no linked agent stays silent.
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
    setPending({ value, replaced: card.linkedAgent });
    try {
      const result = await linkAccountAgent(channel, agent, t("connections.accounts.linkFailed"));
      const account = card.label;
      // Confirmations, not errors, so they skip `onFlash`.
      if (agent === null) {
        toast(t("connections.accounts.linkCleared", { account }));
      } else if (result.unlinkedFrom) {
        toast(t("connections.accounts.linkMoved", { agent: agentLabel(agent), account }));
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

  const triggerId = `linked-agent-${channel}`;
  return (
    <Field>
      <FieldLabel htmlFor={triggerId}>{t("connections.accounts.linkedAgent")}</FieldLabel>
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
        <FieldDescription>{t("connections.accounts.linkedAgentDescription")}</FieldDescription>
      )}
    </Field>
  );
}

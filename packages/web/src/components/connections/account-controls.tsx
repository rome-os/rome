import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LINKABLE_SERVICES } from "@rome/api-types/linked-agents";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchJson } from "@/lib/fetch-json";
import { createConnection, linkAccountAgent } from "@/lib/connections-api";
import type { ConnectionCard } from "@/lib/connection-cards";

/**
 * Account controls on a channel card: "Add another account" for services that
 * offer several, and the "Linked agent" picker for a linkable service's account
 * whose Talk is connected. Both act on the account (the card's channel), not on
 * a slot, so they sit below the slot cards.
 */

/** Radix Select reserves the empty string, so "no linked agent" needs a value of its own. */
const NO_AGENT = "__none__";

const AGENTS_QUERY_KEY = ["connection-accounts", "agents"] as const;

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
  /** Open another account's card by its route. Without it, the add button is hidden. */
  onOpenAccount?: (route: string) => void | Promise<void>;
}) {
  const connected = talkConnected(card);
  const showLink =
    card.linkReported && card.channel !== null && connected && LINKABLE_SERVICES.has(card.service);
  // A second account only makes sense next to a first one that exists.
  const showAdd = card.severalAccounts && connected && onOpenAccount !== undefined;
  if (!showLink && !showAdd) return null;

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
      const connection = await createConnection(service);
      await onOpenAccount(connection.channel || connection.service);
    } catch (error) {
      onFlash(errorMessage(error, t("connections.accounts.addFailed")));
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
  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => {
      const payload = await fetchJson<{ agents: AgentOption[] }>("/api/agents", {
        fallback: t("connections.accounts.agentsFailed"),
      });
      // Main answers wherever no agent is linked, so "None" stands for it.
      return payload.agents
        .map((agent) => agent.name)
        .filter((name) => name !== "main" && name !== "core:main");
    },
  });

  // Keep the current link selectable even when its agent is no longer loaded,
  // so the trigger shows what the server holds.
  const names = agentsQuery.data ?? [];
  const options =
    card.linkedAgent && !names.includes(card.linkedAgent) ? [card.linkedAgent, ...names] : names;

  const change = async (value: string) => {
    const agent = value === NO_AGENT ? null : value;
    if (agent === card.linkedAgent) return;
    setSaving(true);
    try {
      const result = await linkAccountAgent(channel, agent);
      const account = card.label;
      if (agent === null) {
        onFlash(t("connections.accounts.linkCleared", { account }));
      } else if (result.unlinkedFrom) {
        onFlash(t("connections.accounts.linkMoved", { agent, account }));
      } else {
        onFlash(t("connections.accounts.linked", { agent, account }));
      }
      onRefresh();
    } catch (error) {
      onFlash(errorMessage(error, t("connections.accounts.linkFailed")));
    } finally {
      setSaving(false);
    }
  };

  const triggerId = `linked-agent-${channel}`;
  return (
    <Field>
      <FieldLabel htmlFor={triggerId}>{t("connections.accounts.linkedAgent")}</FieldLabel>
      <Select
        value={card.linkedAgent ?? NO_AGENT}
        onValueChange={(value) => void change(value)}
        disabled={saving}
      >
        <SelectTrigger id={triggerId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_AGENT}>{t("connections.accounts.noAgent")}</SelectItem>
          {options.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{t("connections.accounts.linkedAgentDescription")}</FieldDescription>
    </Field>
  );
}

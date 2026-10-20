import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MAIN_AGENT_ID, agentLabel } from "@rome/api-types/account-agents";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FormError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { linkAccountAgent } from "@/lib/connections-api";
import { AgentText } from "./agent-text";
import { type Envoy, type EnvoyAccount, displacedAccount } from "./envoys-model";

/** Radix Select reserves the empty string, so "no agent" needs a value of its own. */
const NO_AGENT = "__none__";

/** Links, switches or unlinks an account's agent. Every read of accounts and
 *  their agents is stale once it lands, the Connections cards' included. */
function useLinkAgent() {
  const { t } = useTranslation("envoys");
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { channel: string; agent: string | null }) =>
      linkAccountAgent(vars.channel, vars.agent, t("change.failed")),
    onSuccess: () =>
      Promise.all(
        [["envoys"], ["connection-detail"], ["connection-accounts"]].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The agent select for one account, with the confirmation a change needs.
 * Switching or unlinking always asks first. Linking an account with no agent
 * asks only when it moves the agent off another account.
 */
export function AgentChange({
  account,
  envoys,
  agents,
  onChanged,
}: {
  account: EnvoyAccount;
  envoys: readonly Envoy[];
  agents: readonly string[];
  onChanged: (agent: string | null) => void;
}) {
  const { t } = useTranslation("envoys");
  const link = useLinkAgent();
  const [pending, setPending] = useState<string | null>(null);
  const current = account.agent ?? NO_AGENT;
  const id = `agent-${account.channel}`;

  // A delegate is the guardian's pick, with main suggested.
  const suggestMain = account.kind === "delegate" && account.agent === null;
  const options = agents.includes(current) || current === NO_AGENT ? agents : [current, ...agents];

  const apply = (value: string) => {
    const agent = value === NO_AGENT ? null : value;
    link.mutate(
      { channel: account.channel, agent },
      {
        onSuccess: () => {
          setPending(null);
          onChanged(agent);
        },
      },
    );
  };

  const choose = (value: string) => {
    link.reset();
    if (value === current) {
      setPending(null);
    } else if (account.agent === null && !displacedAccount(envoys, account, value)) {
      apply(value);
    } else {
      setPending(value);
    }
  };

  const displaced =
    pending && pending !== NO_AGENT ? displacedAccount(envoys, account, pending) : null;

  return (
    <div className="flex flex-col gap-3">
      <Field className="max-w-xs">
        <FieldLabel htmlFor={id}>{t("change.agent")}</FieldLabel>
        <Select value={pending ?? current} disabled={link.isPending} onValueChange={choose}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder={t("change.pick")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((agent) => (
              <SelectItem key={agent} value={agent}>
                {suggestMain && agent === MAIN_AGENT_ID
                  ? t("change.suggested", { agent: agentLabel(agent) })
                  : agentLabel(agent)}
              </SelectItem>
            ))}
            {account.agent !== null && (
              <SelectItem value={NO_AGENT}>{t("change.noAgent")}</SelectItem>
            )}
          </SelectContent>
        </Select>
        {link.error && !pending && (
          <FormError>{errorMessage(link.error, t("change.failed"))}</FormError>
        )}
      </Field>
      {pending && (
        <div className="flex flex-col gap-3 rounded-8 bg-surface-muted p-3 text-ui">
          <p>
            {pending === NO_AGENT ? (
              <AgentText
                k="change.unlinkConfirm"
                values={{ account: account.name, agent: agentLabel(account.agent ?? "") }}
              />
            ) : (
              <AgentText
                k={account.agent === null ? "change.linkConfirm" : "change.switchConfirm"}
                values={{ account: account.name, to: agentLabel(pending) }}
              />
            )}{" "}
            {displaced && (
              <AgentText
                k="change.displaces"
                values={{ to: agentLabel(pending), other: displaced.name }}
              />
            )}
          </p>
          {link.error && <FormError>{errorMessage(link.error, t("change.failed"))}</FormError>}
          <div className="flex gap-2">
            <Button size="sm" disabled={link.isPending} onClick={() => apply(pending)}>
              {pending === NO_AGENT
                ? t("change.unlink")
                : account.agent === null
                  ? t("change.link")
                  : t("change.switch")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={link.isPending}
              onClick={() => {
                link.reset();
                setPending(null);
              }}
            >
              {t("change.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MAIN_AGENT_ID, agentLabel } from "@rome/api-types/account-agents";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { serviceLabel } from "@/lib/connection-cards";
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
 * asks when it moves the agent off another account, or when the account is
 * the guardian's own, since the agent then answers on their behalf.
 */
export function AgentChange({
  account,
  envoys,
  agents,
  disabled = false,
  onChanged,
  children,
}: {
  account: EnvoyAccount;
  envoys: readonly Envoy[];
  agents: readonly string[];
  /** The agent list is still loading, so the options are not final yet. */
  disabled?: boolean;
  onChanged: (agent: string | null) => void;
  /** The account as the row shows it, beside the select. */
  children: ReactNode;
}) {
  const { t } = useTranslation("envoys");
  const link = useLinkAgent();
  const [pending, setPending] = useState<string | null>(null);
  const current = account.agent ?? NO_AGENT;

  // A delegate is the guardian's pick, with main suggested.
  const suggestMain = account.kind === "delegate" && account.agent === null;
  const options = agents.includes(current) || current === NO_AGENT ? agents : [current, ...agents];

  const apply = (value: string) => {
    const agent = value === NO_AGENT ? null : value;
    // `mutateAsync` settles even once the refetch has moved this row away, so
    // the page still hears about the change. Its error shows through `link.error`.
    const predicted = agent !== null && displacedAccount(envoys, account, agent) !== null;
    link.mutateAsync({ channel: account.channel, agent }).then(
      (result) => {
        setPending(null);
        // The confirm sees only connected accounts, so core can move the agent
        // off one it never showed.
        if (agent && result.unlinkedFrom && !predicted) {
          toast(
            t("change.moved", {
              agent: agentLabel(agent),
              platform: serviceLabel(account.platform),
            }),
          );
        }
        onChanged(agent);
      },
      () => {},
    );
  };

  const choose = (value: string) => {
    link.reset();
    if (value === current) {
      setPending(null);
    } else if (
      account.agent === null &&
      account.kind !== "delegate" &&
      !displacedAccount(envoys, account, value)
    ) {
      apply(value);
    } else {
      setPending(value);
    }
  };

  const displaced =
    pending && pending !== NO_AGENT ? displacedAccount(envoys, account, pending) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
        {/* Radix shows the placeholder only for an empty value. */}
        <Select
          value={pending ?? account.agent ?? ""}
          disabled={disabled || link.isPending}
          onValueChange={choose}
        >
          <SelectTrigger
            className="w-40 shrink-0 sm:w-48"
            aria-label={t("change.agentFor", { account: account.name })}
          >
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
      </div>
      {link.error && !pending && (
        <FormError>{errorMessage(link.error, t("change.failed"))}</FormError>
      )}
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
                k={
                  account.kind === "delegate"
                    ? account.agent === null
                      ? "change.delegateConfirm"
                      : "change.delegateSwitchConfirm"
                    : account.agent === null
                      ? "change.linkConfirm"
                      : "change.switchConfirm"
                }
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

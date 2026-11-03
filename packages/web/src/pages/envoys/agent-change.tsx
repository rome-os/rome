import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { linkAccountAgent, revokeConnectionGrant } from "@/lib/connections-api";
import { AgentText } from "./agent-text";
import { CONNECTIONS_KEY, type EnvoyAccount } from "./envoys-model";

/** Radix Select reserves the empty string, so "no agent" needs a value of its own. */
const NO_AGENT = "__none__";

/** Envoys and the Connections cards (ConnectionDetailPage's connections key)
 *  are stale once a change to an account lands. */
function useRefetchAccounts() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [CONNECTIONS_KEY, ["connection-detail", "connections"]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

/** Links, switches or unlinks an account's agent. */
function useLinkAgent() {
  const { t } = useTranslation("envoys");
  const refetch = useRefetchAccounts();
  return useMutation({
    mutationFn: (vars: { connectionId: string; agent: string | null }) =>
      linkAccountAgent(vars.connectionId, vars.agent, t("change.failed")),
    onSuccess: refetch,
  });
}

/** Disconnects an account, which removes it. */
function useDisconnect() {
  const { t } = useTranslation("envoys");
  const refetch = useRefetchAccounts();
  return useMutation({
    mutationFn: async (account: EnvoyAccount) => {
      const result = await revokeConnectionGrant(account.connectionId, account.grant);
      if (!result.ok) throw new Error(result.error || t("disconnect.failed"));
    },
    onSuccess: refetch,
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The agent select for one account, with the confirmation a change needs, and
 * Disconnect. Switching or unlinking always asks first. Linking an account
 * with no agent asks only when the account is the guardian's own, since the
 * agent then answers on their behalf. Disconnecting always asks first. Only
 * this account changes.
 */
export function AgentChange({
  account,
  agents,
  disabled = false,
  onChanged,
  onDisconnected,
  children,
}: {
  account: EnvoyAccount;
  agents: readonly string[];
  /** The agent list is still loading, so the options are not final yet. */
  disabled?: boolean;
  onChanged: (agent: string | null) => void;
  onDisconnected: () => void;
  /** The account as the row shows it, beside the select. */
  children: ReactNode;
}) {
  const { t } = useTranslation("envoys");
  const link = useLinkAgent();
  const disconnect = useDisconnect();
  const [pending, setPending] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const busy = link.isPending || disconnect.isPending;
  const current = account.agent ?? NO_AGENT;

  // A delegate is the guardian's pick, with main suggested.
  const suggestMain = account.kind === "delegate" && account.agent === null;
  const options = agents.includes(current) || current === NO_AGENT ? agents : [current, ...agents];

  const apply = (value: string) => {
    const agent = value === NO_AGENT ? null : value;
    // `mutateAsync` settles even once the refetch has moved this row away, so
    // the page still hears about the change. Its error shows through `link.error`.
    link.mutateAsync({ connectionId: account.connectionId, agent }).then(
      () => {
        setPending(null);
        onChanged(agent);
      },
      () => {},
    );
  };

  const confirmDisconnect = () => {
    // Like a link, this settles even once the refetch has removed the row.
    disconnect.mutateAsync(account).then(
      () => {
        setDisconnecting(false);
        onDisconnected();
      },
      () => {},
    );
  };

  const choose = (value: string) => {
    link.reset();
    disconnect.reset();
    setDisconnecting(false);
    if (value === current) {
      setPending(null);
    } else if (account.agent === null && account.kind !== "delegate") {
      apply(value);
    } else {
      setPending(value);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Radix shows the placeholder only for an empty value. */}
          <Select
            value={
              pending ??
              (link.isPending ? (link.variables?.agent ?? NO_AGENT) : null) ??
              account.agent ??
              ""
            }
            disabled={disabled || busy}
            onValueChange={choose}
          >
            <SelectTrigger
              className="min-w-0 flex-1 sm:w-48 sm:flex-none"
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
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            aria-label={t("disconnect.accountLabel", { account: account.name })}
            onClick={() => {
              link.reset();
              disconnect.reset();
              setPending(null);
              setDisconnecting(true);
            }}
          >
            {t("disconnect.action")}
          </Button>
        </div>
      </div>
      {disconnecting && (
        <div className="flex flex-col gap-3 rounded-8 bg-surface-muted p-3 text-ui">
          <p>
            {t(account.kind === "delegate" ? "disconnect.delegateConfirm" : "disconnect.confirm", {
              account: account.name,
            })}
          </p>
          {disconnect.error && (
            <FormError>{errorMessage(disconnect.error, t("disconnect.failed"))}</FormError>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={confirmDisconnect}
            >
              {disconnect.isPending ? t("disconnect.pending") : t("disconnect.action")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => {
                disconnect.reset();
                setDisconnecting(false);
              }}
            >
              {t("change.cancel")}
            </Button>
          </div>
        </div>
      )}
      {link.error && !pending && (
        <FormError>{errorMessage(link.error, t("change.failed"))}</FormError>
      )}
      {pending && (
        <div className="flex flex-col gap-3 rounded-8 bg-surface-muted p-3 text-ui">
          <p>
            {pending === NO_AGENT ? (
              <AgentText
                k={
                  account.kind === "delegate"
                    ? "change.delegateUnlinkConfirm"
                    : "change.unlinkConfirm"
                }
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

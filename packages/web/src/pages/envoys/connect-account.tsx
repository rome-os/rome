import { type ReactNode, useState } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  Page,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { agentLabel, canonicalAgent } from "@rome/api-types/account-agents";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { CHANNEL_CONFIGS, ChannelConnectCard } from "@/components/channels/channel-connect-card";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { serviceLabel, type ConnectionSlot } from "@/lib/connection-cards";
import { type ApiConnection, fetchConnections, linkAccountAgent } from "@/lib/connections-api";
import { Avatar } from "../people/avatar";
import { AgentText } from "./agent-text";
import { BackLink } from "./back-link";
import { CONNECTIONS_KEY, type ConnectChoice, connectChoices } from "./envoys-model";

/**
 * Connect an account: pick the agent that speaks through it, then the
 * platform, then run that platform's setup. The account is created only once
 * the setup connects it, and the agent is linked to it then.
 */

export const CONNECT_PATH = "/envoys/connect";

const agentConnectPath = (agent: string) => `${CONNECT_PATH}/${encodeURIComponent(agent)}`;

export function ConnectAccount({
  connections,
  agents,
  navigate,
}: {
  connections: readonly ApiConnection[];
  /** Every agent an account can be linked to, main first. */
  agents: readonly string[];
  /** Navigates unless the guardian has left Envoys. */
  navigate: (to: string) => void;
}) {
  return (
    <Routes>
      <Route index element={<PickAgent agents={agents} />} />
      <Route path=":agent" element={<PickPlatform connections={connections} />} />
      <Route
        path=":agent/:service"
        element={<ConnectOn connections={connections} navigate={navigate} />}
      />
    </Routes>
  );
}

function useAgentParam(): string {
  return canonicalAgent(useParams<{ agent: string }>().agent ?? "");
}

function PickAgent({ agents }: { agents: readonly string[] }) {
  const { t } = useTranslation("envoys");
  useDocumentTitle([t("connect.title"), t("index.title")]);
  return (
    <Page>
      <BackLink to="/envoys">{t("index.title")}</BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("connect.title")}</PageTitle>
          <PageDescription>{t("connect.description")}</PageDescription>
        </PageHeading>
      </PageHeader>
      <List className="max-w-3xl overflow-hidden rounded-12 border border-border-subtle">
        {agents.map((agent) => {
          const name = agentLabel(agent);
          return (
            <ListRow key={agent} asChild interactive>
              <Link to={agentConnectPath(agent)}>
                <Avatar name={name} />
                <ListRowContent>
                  <ListRowTitle className="truncate font-mono">{name}</ListRowTitle>
                </ListRowContent>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </ListRow>
          );
        })}
      </List>
    </Page>
  );
}

function PickPlatform({ connections }: { connections: readonly ApiConnection[] }) {
  const { t } = useTranslation("envoys");
  const agent = useAgentParam();
  const name = agentLabel(agent);
  useDocumentTitle([t("connect.title"), t("index.title")]);
  const choices = connectChoices(connections);
  const own = choices.filter((choice) => choice.kind === "own");
  const delegate = choices.filter((choice) => choice.kind === "delegate");
  return (
    <Page>
      <BackLink to={CONNECT_PATH}>{t("connect.agents")}</BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>
            <AgentText k="connect.forAgent" values={{ agent: name }} />
          </PageTitle>
          <PageDescription>{t("connect.anyNumber")}</PageDescription>
        </PageHeading>
      </PageHeader>
      {own.length > 0 && (
        <PlatformSection
          title={<AgentText k="connect.ownTitle" values={{ agent: name }} />}
          description={<AgentText k="connect.ownBody" values={{ agent: name }} />}
          agent={agent}
          choices={own}
        />
      )}
      {delegate.length > 0 && (
        <PlatformSection
          title={t("connect.delegateTitle")}
          description={<AgentText k="connect.delegateBody" values={{ agent: name }} />}
          agent={agent}
          choices={delegate}
        />
      )}
    </Page>
  );
}

function PlatformSection({
  title,
  description,
  agent,
  choices,
}: {
  title: ReactNode;
  description: ReactNode;
  agent: string;
  choices: ConnectChoice[];
}) {
  const { t } = useTranslation("envoys");
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{title}</SectionTitle>
          <SectionDescription>{description}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <List className="max-w-3xl overflow-hidden rounded-12 border border-border-subtle">
        {choices.map((choice) => {
          const app = serviceLabel(choice.platform);
          const content = (
            <>
              <ConnectionBrandBadge connection={choice.platform} />
              <ListRowContent>
                <ListRowTitle className="truncate">
                  {choice.kind === "delegate" ? t("connect.yourAccount", { app }) : app}
                </ListRowTitle>
                {choice.taken && <ListRowDescription>{t("connect.taken")}</ListRowDescription>}
              </ListRowContent>
            </>
          );
          if (choice.taken) return <ListRow key={choice.service}>{content}</ListRow>;
          return (
            <ListRow key={choice.service} asChild interactive>
              <Link to={`${agentConnectPath(agent)}/${encodeURIComponent(choice.service)}`}>
                {content}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </ListRow>
          );
        })}
      </List>
    </Section>
  );
}

function ConnectOn({
  connections,
  navigate,
}: {
  connections: readonly ApiConnection[];
  navigate: (to: string) => void;
}) {
  const { t } = useTranslation("envoys");
  const queryClient = useQueryClient();
  const agent = useAgentParam();
  const service = useParams<{ service: string }>().service ?? "";
  const name = agentLabel(agent);
  useDocumentTitle([t("connect.title"), t("index.title")]);
  // Read once: a poll that sees the new account connected mid-setup would
  // otherwise turn the setup into another one and cancel it.
  const [choice] = useState(() =>
    connectChoices(connections).find((candidate) => candidate.service === service),
  );
  const config = CHANNEL_CONFIGS[service];
  const back = <BackLink to={agentConnectPath(agent)}>{t("connect.platforms")}</BackLink>;
  if (!choice || choice.taken || !config) {
    return (
      <Page>
        {back}
        <p className="text-ui text-muted-foreground">{t("connect.unavailable")}</p>
      </Page>
    );
  }
  const app = serviceLabel(choice.platform);
  const delegate = choice.kind === "delegate";

  const slot: ConnectionSlot = {
    key: delegate ? "session" : "bot",
    connectionId: null,
    grant: config.defaultGrant,
    state: "unauthorized",
    display: null,
    identity: null,
    activeSetupCid: choice.activeSetupCid,
  };

  const refetch = () =>
    Promise.all(
      [CONNECTIONS_KEY, ["connection-detail", "connections"]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );

  const leave = async (message: string) => {
    // Not an error: the account is connected either way.
    toast(message);
    await refetch();
    navigate("/envoys");
  };

  // Core links a service's first account to main and leaves a later one with
  // no agent, so the picked agent is linked once the account exists.
  const connected = async (connectionId: string | null) => {
    let account: ApiConnection | undefined;
    try {
      // Fetched apart from the polled query, whose request in flight may have
      // started before the account existed.
      if (connectionId) account = (await fetchConnections()).find((c) => c.id === connectionId);
    } catch {
      account = undefined;
    }
    if (!account?.channel) return leave(t("connect.notFound", { agent: name }));
    const linked = account.agent ? canonicalAgent(account.agent) : null;
    if (linked !== agent) {
      try {
        await linkAccountAgent(account.channel, agent, t("change.failed"));
      } catch {
        // Unlink the agent core gave the account, so the account waits under
        // Connected, no agent rather than answering as an agent nobody picked.
        if (linked !== null) {
          try {
            await linkAccountAgent(account.channel, null, t("change.failed"));
          } catch {
            return leave(t("connect.linkFailedKept", { agent: name, kept: agentLabel(linked) }));
          }
        }
        return leave(t("connect.linkFailed", { agent: name }));
      }
    }
    await refetch();
    navigate(`/envoys/${encodeURIComponent(agent)}`);
  };

  return (
    <Page>
      {back}
      <PageHeader>
        <PageHeading>
          <PageTitle>
            {delegate ? (
              t("connect.delegateOnTitle", { app })
            ) : (
              <AgentText k="connect.onTitle" values={{ app, agent: name }} />
            )}
          </PageTitle>
          <PageDescription>
            <AgentText
              k={delegate ? "connect.delegateOnDescription" : "connect.onDescription"}
              values={{ agent: name }}
            />
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <div className="max-w-3xl">
        <ChannelConnectCard
          config={config}
          slot={slot}
          role="primary"
          another={choice.another}
          // Only this page links the picked agent, so a setup it leaves behind
          // could connect an account that answers as no agent anyone picked.
          cancelOnLeave
          onRefresh={() => void refetch()}
          onConnected={(connectionId) => void connected(connectionId)}
        />
      </div>
    </Page>
  );
}

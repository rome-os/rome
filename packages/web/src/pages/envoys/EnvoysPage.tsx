import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { Link, Navigate, Route, Routes, useMatch, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageNav,
  PageNavLink,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { ListGrid } from "@rome-os/ui/layout-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { FormError } from "@/components/ui/field";
import { List, ListRow, ListRowContent } from "@/components/ui/list-row";
import {
  ConnectionBrandBadge,
  DiscordIcon,
  FeishuIcon,
  TelegramIcon,
  WeChatIcon,
} from "@/components/brand-icons/connection-badges";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  type ApiConnection,
  CONNECTIONS_REFRESH_INTERVAL_MS,
  fetchConnections,
} from "@/lib/connections-api";
import { serviceLabel } from "@/lib/connection-cards";
import { fetchJson } from "@/lib/fetch-json";
import { Avatar } from "../people/avatar";
import { agentLabel, canonicalAgent } from "@rome/api-types/account-agents";
import { AgentChange } from "./agent-change";
import { AgentText } from "./agent-text";
import { BackLink } from "./back-link";
import { CONNECT_PATH, ConnectAccount } from "./connect-account";
import {
  type AgentListing,
  CONNECTIONS_KEY,
  type Envoy,
  type EnvoyAccount,
  buildEnvoys,
} from "./envoys-model";

/**
 * Envoys: the agents people can reach on chat platforms, each listed with the
 * accounts it speaks through. Connected accounts with no agent are listed
 * apart, each with a picker that links an agent. An agent's Settings switch or
 * unlink the agent of each of its accounts. Every such row also disconnects
 * its account. Connect an account picks the agent first, then the platform.
 */
export default function EnvoysPage() {
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return (
    <EnvoysOpen.Provider value={open}>
      <Routes>
        <Route index element={<EnvoysIndex />} />
        <Route path="connect/*" element={<EnvoysConnect />} />
        <Route path=":agent/*" element={<EnvoyDetail />} />
      </Routes>
    </EnvoysOpen.Provider>
  );
}

/** Whether the guardian is still on Envoys. A change lands after its refetch,
 *  by which time they may have gone elsewhere. */
const EnvoysOpen = createContext<{ readonly current: boolean }>({ current: true });

/** Navigates after a change lands, unless the guardian has left Envoys. */
function useNavigateAfterChange() {
  const navigate = useNavigate();
  const open = useContext(EnvoysOpen);
  return useCallback(
    (to: string) => {
      if (open.current) navigate(to);
    },
    [navigate, open],
  );
}

const CONNECTIONS_PATH = "/settings/connections";

const envoyPath = (agent: string) => `/envoys/${encodeURIComponent(agent)}`;

const accountPath = (route: string) => `${CONNECTIONS_PATH}/${encodeURIComponent(route)}`;

type EnvoysData = ReturnType<typeof buildEnvoys> & {
  connections: ApiConnection[];
  agentsPending: boolean;
  agentsFailed: boolean;
};

function useEnvoys() {
  const { t } = useTranslation("envoys");
  const connections = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: fetchConnections,
    // Links change on the Connections cards, so a return here reads them fresh.
    staleTime: 0,
    refetchInterval: CONNECTIONS_REFRESH_INTERVAL_MS,
  });
  const agents = useQuery({
    queryKey: ["envoys", "agents"],
    staleTime: 60_000,
    queryFn: () =>
      fetchJson<{ agents: AgentListing[] }>("/api/agents", { fallback: t("loadFailed") }),
  });
  return {
    // Descriptions are optional, so the list renders without the agents.
    data: connections.data
      ? {
          ...buildEnvoys(connections.data, agents.data?.agents ?? null),
          connections: connections.data,
          agentsPending: agents.isPending,
          agentsFailed: agents.isError,
        }
      : undefined,
    isPending: connections.isPending,
    error: connections.error,
  };
}

function Loading() {
  const { t } = useTranslation("envoys");
  return <p className="py-12 text-center text-ui text-muted-foreground">{t("loading")}</p>;
}

function LoadError() {
  const { t } = useTranslation("envoys");
  return <p className="text-ui text-destructive">{t("loadFailed")}</p>;
}

const PLATFORM_ICONS: Partial<Record<string, typeof FeishuIcon>> = {
  feishu: FeishuIcon,
  telegram: TelegramIcon,
  discord: DiscordIcon,
  wechat: WeChatIcon,
};

function AccountPills({ accounts }: { accounts: EnvoyAccount[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {accounts.map((account) => {
        const Icon = PLATFORM_ICONS[account.platform];
        return (
          <Badge key={account.channel} variant="outline">
            {Icon && <Icon aria-hidden="true" />}
            {account.name}
          </Badge>
        );
      })}
    </span>
  );
}

/** Opens Connect an account, at the platform step when the agent is known. */
function ConnectButton({ primary, agent }: { primary: boolean; agent?: string }) {
  const { t } = useTranslation("envoys");
  return (
    <Button asChild variant={primary ? "default" : "ghost"} size={primary ? undefined : "sm"}>
      <Link to={agent ? `${CONNECT_PATH}/${encodeURIComponent(agent)}` : CONNECT_PATH}>
        {t("index.add")}
      </Link>
    </Button>
  );
}

function EnvoysConnect() {
  const query = useEnvoys();
  const navigate = useNavigateAfterChange();
  if (!query.data) return <Page>{query.isPending ? <Loading /> : <LoadError />}</Page>;
  return (
    <ConnectAccount
      connections={query.data.connections}
      agents={query.data.agents}
      navigate={navigate}
    />
  );
}

// ─── Envoys list ─────────────────────────────────────────────────────────────

function EnvoysIndex() {
  const { t } = useTranslation("envoys");
  const query = useEnvoys();
  const envoys = query.data?.envoys ?? [];
  const unlinked = query.data?.unlinked ?? [];
  useDocumentTitle([t("index.title")]);

  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("index.title")}</PageTitle>
          <PageDescription>{t("index.description")}</PageDescription>
        </PageHeading>
        <PageActions>
          <ConnectButton primary />
        </PageActions>
      </PageHeader>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <LoadError />
      ) : envoys.length === 0 && unlinked.length === 0 ? (
        <EmptyState>
          <EmptyStateTitle>{t("index.emptyTitle")}</EmptyStateTitle>
          <EmptyStateDescription>{t("index.emptyBody")}</EmptyStateDescription>
          <EmptyStateAction>
            <ConnectButton primary />
          </EmptyStateAction>
        </EmptyState>
      ) : (
        <>
          {envoys.length > 0 && (
            <ListGrid>
              {envoys.map((envoy) => (
                <EnvoyCard key={envoy.agent} envoy={envoy} />
              ))}
            </ListGrid>
          )}
          {query.data && unlinked.length > 0 && <UnlinkedAccounts data={query.data} />}
        </>
      )}
    </Page>
  );
}

function EnvoyCard({ envoy }: { envoy: Envoy }) {
  const { t } = useTranslation("envoys");
  const name = agentLabel(envoy.agent);
  return (
    <Link
      to={envoyPath(envoy.agent)}
      className="rounded-12 outline-none outline-1 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
    >
      <Card className="h-full transition-colors hover:bg-surface-hover">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Avatar name={name} />
            <div className="min-w-0">
              <CardTitle className="font-mono">{name}</CardTitle>
              <CardDescription>
                {t("accountCount", { count: envoy.accounts.length })}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {envoy.description && (
            <p className="text-ui text-muted-foreground">{envoy.description}</p>
          )}
          <AccountPills accounts={envoy.accounts} />
        </CardContent>
      </Card>
    </Link>
  );
}

/** `linked` makes the name open the account's Connections card, for rows
 *  that are not a link as a whole. */
function AccountSummary({ account, linked = false }: { account: EnvoyAccount; linked?: boolean }) {
  const { t } = useTranslation("envoys");
  return (
    <>
      <ConnectionBrandBadge connection={account.platform} />
      <ListRowContent>
        {linked && account.route !== null ? (
          <Link
            to={accountPath(account.route)}
            className="block truncate rounded-4 font-medium underline-offset-2 outline-none outline-1 outline-transparent hover:underline focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            {account.name}
          </Link>
        ) : (
          <div className="truncate font-medium">{account.name}</div>
        )}
        <div className="truncate text-aux text-muted-foreground">
          {serviceLabel(account.platform)}
          {account.kind === "delegate" && ` · ${t("kinds.yours")}`}
        </div>
      </ListRowContent>
    </>
  );
}

function AccountRow({ account }: { account: EnvoyAccount }) {
  const { t } = useTranslation("envoys");
  const content = (
    <>
      <AccountSummary account={account} />
      <Badge variant={account.kind === "delegate" ? "info" : "success"}>
        {t(`kinds.${account.kind}`)}
      </Badge>
    </>
  );
  // No Connections card shows a delegate's agent yet, so its row opens nothing.
  if (account.route === null) return <ListRow>{content}</ListRow>;
  return (
    <ListRow asChild interactive>
      <Link to={accountPath(account.route)}>{content}</Link>
    </ListRow>
  );
}

/** One account with the select that changes its agent, and Disconnect. */
function AccountAgentRow({
  account,
  data,
  onChanged,
  onDisconnected = () => {},
}: {
  account: EnvoyAccount;
  data: EnvoysData;
  onChanged: (agent: string | null) => void;
  onDisconnected?: () => void;
}) {
  return (
    <div className="py-3">
      <AgentChange
        account={account}
        agents={data.agents}
        disabled={data.agentsPending}
        onChanged={onChanged}
        onDisconnected={onDisconnected}
      >
        <AccountSummary account={account} linked />
      </AgentChange>
    </div>
  );
}

/** Shown once above the selects when the agent list failed to load, since each
 *  select then offers only main and the agents already linked. */
function AgentsFailed({ data }: { data: EnvoysData }) {
  const { t } = useTranslation("envoys");
  return data.agentsFailed ? <FormError>{t("change.agentsFailed")}</FormError> : null;
}

/** Accounts Rome has access to but no agent speaks through. Linking an agent
 *  opens that agent's page. */
function UnlinkedAccounts({ data }: { data: EnvoysData }) {
  const { t } = useTranslation("envoys");
  const navigate = useNavigateAfterChange();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{t("unlinked.title")}</SectionTitle>
          <SectionDescription>{t("unlinked.description")}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <AgentsFailed data={data} />
      <Card className="max-w-3xl">
        <CardContent className="divide-y divide-border-subtle">
          {data.unlinked.map((account) => (
            <AccountAgentRow
              key={account.channel}
              account={account}
              data={data}
              onChanged={(agent) => agent && navigate(envoyPath(agent))}
            />
          ))}
        </CardContent>
      </Card>
    </Section>
  );
}

// ─── One agent ───────────────────────────────────────────────────────────────

function EnvoyDetail() {
  const { t } = useTranslation("envoys");
  // A shared link may name main by its short name.
  const agent = canonicalAgent(useParams<{ agent: string }>().agent ?? "");
  const query = useEnvoys();
  const envoy = query.data?.envoys.find((candidate) => candidate.agent === agent);
  const name = agentLabel(agent);
  const activeTab = useMatch("/envoys/:agent/settings") ? "settings" : "overview";
  useDocumentTitle([name, t("index.title")]);

  return (
    <Page>
      <BackLink to="/envoys">{t("index.title")}</BackLink>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <LoadError />
      ) : !envoy ? (
        <p className="text-ui text-muted-foreground">
          <AgentText k="agent.missing" values={{ agent: name }} />
        </p>
      ) : (
        <>
          <PageHeader>
            <PageHeading>
              <div className="flex items-center gap-3">
                <Avatar name={name} size="lg" />
                <div className="min-w-0">
                  <PageTitle className="font-mono">{name}</PageTitle>
                  {envoy.description && <PageDescription>{envoy.description}</PageDescription>}
                </div>
              </div>
            </PageHeading>
          </PageHeader>
          <PageNav aria-label={name}>
            {TABS.map((tab) => (
              <PageNavLink asChild key={tab.id} active={tab.id === activeTab}>
                <Link to={envoyPath(agent) + tab.path}>{t(`tabs.${tab.id}`)}</Link>
              </PageNavLink>
            ))}
          </PageNav>
          <Routes>
            <Route index element={<Overview envoy={envoy} />} />
            <Route path="settings" element={<Settings envoy={envoy} data={query.data!} />} />
            <Route path="*" element={<Navigate to={envoyPath(agent)} replace />} />
          </Routes>
        </>
      )}
    </Page>
  );
}

const TABS = [
  { id: "overview", path: "" },
  { id: "settings", path: "/settings" },
] as const;

function Overview({ envoy }: { envoy: Envoy }) {
  const { t } = useTranslation("envoys");
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("overview.accounts")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <List>
          {envoy.accounts.map((account) => (
            <AccountRow key={account.channel} account={account} />
          ))}
        </List>
        <div className="flex flex-wrap gap-2">
          <ConnectButton primary={false} agent={envoy.agent} />
        </div>
      </CardContent>
    </Card>
  );
}

function Settings({ envoy, data }: { envoy: Envoy; data: EnvoysData }) {
  const { t } = useTranslation("envoys");
  const navigate = useNavigateAfterChange();
  const queryClient = useQueryClient();
  // Read after the change's refetch, so two changes at once both see the
  // accounts that are left rather than the count when they started.
  const keepsAccounts = () => {
    const connections = queryClient.getQueryData<ApiConnection[]>(CONNECTIONS_KEY);
    if (!connections) return envoy.accounts.length > 1;
    return buildEnvoys(connections, null).envoys.some((other) => other.agent === envoy.agent);
  };
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t("overview.accounts")}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border-subtle">
        <AgentsFailed data={data} />
        {envoy.accounts.map((account) => (
          <AccountAgentRow
            key={account.channel}
            account={account}
            data={data}
            onChanged={(agent) => {
              // Stay while this agent keeps other accounts. Otherwise follow the
              // account to its new agent's page, or back to the list.
              if (keepsAccounts()) return;
              navigate(agent ? `${envoyPath(agent)}/settings` : "/envoys");
            }}
            onDisconnected={() => {
              if (!keepsAccounts()) navigate("/envoys");
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

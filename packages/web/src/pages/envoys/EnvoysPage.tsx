import type { ReactNode } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import {
  Page,
  PageActions,
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
import { List, ListRow, ListRowContent } from "@/components/ui/list-row";
import {
  ConnectionBrandBadge,
  DiscordIcon,
  FeishuIcon,
  TelegramIcon,
  WeChatIcon,
} from "@/components/brand-icons/connection-badges";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { CONNECTIONS_REFRESH_INTERVAL_MS, fetchConnections } from "@/lib/connections-api";
import { serviceLabel } from "@/lib/connection-cards";
import { fetchJson } from "@/lib/fetch-json";
import { Avatar } from "../people/avatar";
import { agentLabel, canonicalAgent } from "@rome/api-types/account-agents";
import { type AgentListing, type Envoy, type EnvoyAccount, buildEnvoys } from "./envoys-model";

/**
 * Envoys: the agents people can reach on chat platforms, each listed with the
 * accounts it speaks through. Connected accounts with no agent are listed
 * apart. Connecting an account and picking its agent still happen on the
 * account's Connections card, which every row here opens.
 */
export default function EnvoysPage() {
  return (
    <Routes>
      <Route index element={<EnvoysIndex />} />
      <Route path=":agent" element={<EnvoyDetail />} />
    </Routes>
  );
}

const CONNECTIONS_PATH = "/settings/connections";

const envoyPath = (agent: string) => `/envoys/${encodeURIComponent(agent)}`;

const accountPath = (route: string) => `${CONNECTIONS_PATH}/${encodeURIComponent(route)}`;

function useEnvoys() {
  const { t } = useTranslation("envoys");
  const connections = useQuery({
    queryKey: ["envoys", "connections"],
    queryFn: fetchConnections,
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
    data: connections.data ? buildEnvoys(connections.data, agents.data?.agents ?? []) : undefined,
    isPending: connections.isPending,
    error: connections.error,
  };
}

function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" align="start" className="self-start">
      <Link to={to}>
        <ArrowLeft data-icon="inline-start" />
        {children}
      </Link>
    </Button>
  );
}

function Loading() {
  const { t } = useTranslation("envoys");
  return <p className="py-12 text-center text-ui text-muted-foreground">{t("loading")}</p>;
}

function LoadError() {
  const { t } = useTranslation("envoys");
  return <p className="text-ui text-destructive">{t("loadFailed")}</p>;
}

/** A sentence whose `<agent>` tag sets the agent's name in monospace, so a
 *  name such as main does not read as a plain word. */
function AgentText({ k, values }: { k: string; values: Record<string, unknown> }) {
  const { t } = useTranslation("envoys");
  return (
    <Trans
      t={t}
      i18nKey={k}
      values={values}
      components={{ agent: <span className="font-mono" /> }}
    />
  );
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

function ConnectButton({ primary }: { primary: boolean }) {
  const { t } = useTranslation("envoys");
  return (
    <Button asChild variant={primary ? "default" : "ghost"} size={primary ? undefined : "sm"}>
      <Link to={CONNECTIONS_PATH}>{t("index.add")}</Link>
    </Button>
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
          {unlinked.length > 0 && <UnlinkedAccounts accounts={unlinked} />}
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

function AccountRow({ account, action }: { account: EnvoyAccount; action?: string }) {
  const { t } = useTranslation("envoys");
  const content = (
    <>
      <ConnectionBrandBadge connection={account.platform} />
      <ListRowContent>
        <div className="font-medium">{account.name}</div>
        <div className="truncate text-aux text-muted-foreground">
          {serviceLabel(account.platform)}
          {account.kind === "delegate" && ` · ${t("kinds.yours")}`}
        </div>
      </ListRowContent>
      {action ? (
        <span className="text-ui text-muted-foreground">{action}</span>
      ) : (
        <Badge variant={account.kind === "delegate" ? "info" : "success"}>
          {t(`kinds.${account.kind}`)}
        </Badge>
      )}
    </>
  );
  // No Connections card shows a delegate's agent yet, so its row opens nothing.
  if (account.route === null) return <ListRow>{content}</ListRow>;
  return (
    <ListRow asChild interactive>
      <Link
        to={accountPath(account.route)}
        aria-label={action ? t("unlinked.linkTo", { account: account.name }) : undefined}
      >
        {content}
      </Link>
    </ListRow>
  );
}

/** Accounts Rome has access to but no agent speaks through. Each opens its
 *  Connections card, where the agent is picked. */
function UnlinkedAccounts({ accounts }: { accounts: EnvoyAccount[] }) {
  const { t } = useTranslation("envoys");
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>{t("unlinked.title")}</SectionTitle>
          <SectionDescription>{t("unlinked.description")}</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <Card className="max-w-3xl py-0">
        <List>
          {accounts.map((account) => (
            <AccountRow key={account.channel} account={account} action={t("unlinked.link")} />
          ))}
        </List>
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
                <ConnectButton primary={false} />
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </Page>
  );
}

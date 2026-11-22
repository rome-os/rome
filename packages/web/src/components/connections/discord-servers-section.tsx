import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ellipsis, Plus, Trash2 } from "lucide-react";
import {
  Section,
  SectionActions,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { isElectronShell } from "@/lib/electron-shell";

/** A server and an account bound to this Rome, as the Discord bot's Worker lists them. */
interface DiscordServer {
  serverId: string;
  serverName: string;
  /** Its icon on Discord's CDN, or null when it has none. */
  serverIcon: string | null;
}
interface DiscordAccount {
  userId: string;
  name?: string;
}

const BASE = "/api/connections/discord-app";

async function readError(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof payload?.error === "string" ? payload.error : null;
}

/** Discord's page that adds Rome's bot to a server and connects this server to Rome. Rejects with the server's words when it gives none. */
async function discordInstallLink(): Promise<string> {
  const response = await fetch(`${BASE}/install-link`, { method: "POST" });
  if (!response.ok) throw new Error((await readError(response)) ?? "");
  const { url } = (await response.json()) as { url: string };
  return url;
}

/** When Rome last sent the guardian to Discord's page. Coming back to this
 *  tab soon after reads the server list again; any other focus does not, so
 *  the shared bot is not asked on every tab switch. */
let sentToDiscordAt = 0;
const BACK_FROM_DISCORD_MS = 10 * 60_000;

/** A tab for Discord's page, opened during the click, before the link is
 *  known, so no popup blocker stops it. The Mac app opens none: it hands every
 *  page to the system browser. */
export function reserveDiscordTab(): Window | null {
  return isElectronShell() ? null : window.open("", "_blank");
}

/** Opens Discord's page: in the reserved tab, through the Mac app in the
 *  system browser, or in this tab when the browser gave no tab. Rejects, with
 *  the reserved tab closed, when there is no link. */
export async function openDiscordPage(tab: Window | null): Promise<void> {
  let url: string;
  try {
    url = await discordInstallLink();
  } catch (error) {
    tab?.close();
    throw error;
  }
  sentToDiscordAt = Date.now();
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
  } else if (isElectronShell()) {
    window.open(url);
  } else {
    window.location.assign(url);
  }
}

/** The first letters of a name's first two words, as Discord marks a server
 *  that has no icon. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}

/** A server's mark: its icon, or its initials until one loads. */
function Mark({ name, icon }: { name: string; icon: string | null }) {
  return (
    <Avatar className="rounded-8 after:rounded-8">
      {icon && <AvatarImage src={icon} alt="" className="rounded-8" />}
      <AvatarFallback className="rounded-8 text-aux">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** A server's "…" menu, holding Remove. */
function RowMenu({
  label,
  item,
  disabled,
  onSelect,
}: {
  label: string;
  item: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} icon={<Ellipsis />} size="sm" disabled={disabled} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={onSelect}>
          <Trash2 className="size-4" aria-hidden />
          {item}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The connected view of Rome's Discord bot: the servers it was added to, one
 * tile each with Remove in its menu, the people who chose this Rome for DMs, and
 * Disconnect at the bottom. Adding happens on Discord's own page, in a new
 * tab; the list reads again when the guardian comes back to this one.
 */
export function DiscordServersSection({
  onDisconnect,
  disconnecting,
}: {
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const [servers, setServers] = useState<DiscordServer[] | null>(null);
  const [accounts, setAccounts] = useState<DiscordAccount[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BASE}/servers`);
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as {
        servers: DiscordServer[];
        users: DiscordAccount[];
      };
      setServers(data.servers);
      setAccounts(data.users);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Discord's page runs in another tab: coming back from it reads the list again.
    const again = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - sentToDiscordAt < BACK_FROM_DISCORD_MS
      ) {
        void load();
      }
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [load]);

  async function addToServer() {
    setActionError(null);
    const tab = reserveDiscordTab();
    setAdding(true);
    try {
      await openDiscordPage(tab);
    } catch (error) {
      setActionError(
        (error instanceof Error && error.message) || t("channels.discordApp.addFailed"),
      );
    } finally {
      setAdding(false);
    }
  }

  async function remove(server: DiscordServer) {
    setActionError(null);
    setRemoving(server.serverId);
    try {
      const response = await fetch(`${BASE}/servers/${encodeURIComponent(server.serverId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setActionError(t("channels.discordApp.removeFailed", { name: server.serverName }));
    } finally {
      setRemoving(null);
    }
  }

  const names = accounts.map((account) => account.name ?? `…${account.userId.slice(-4)}`);
  const accountName = names.length > 0 ? new Intl.ListFormat(i18n.language).format(names) : "";

  const addButton = (
    <Button size="sm" onClick={() => void addToServer()} disabled={adding}>
      <Plus data-icon="inline-start" aria-hidden />
      {t("channels.discordApp.add")}
    </Button>
  );
  const serverMenu = (server: DiscordServer) => (
    <RowMenu
      label={t("channels.discordApp.manage")}
      item={t("channels.discordApp.remove")}
      disabled={removing !== null}
      onSelect={() => void remove(server)}
    />
  );
  // DM destinations do not grant reply permission.
  const hint = [
    accountName && t("channels.discordApp.linkedAs", { name: accountName }),
    t("channels.discordApp.howTo"),
  ]
    .filter(Boolean)
    .join(" · ");
  const loadFailed = loadError && (
    <div className="flex items-center gap-2">
      <p className="text-aux text-destructive-fg">{t("channels.discordApp.loadFailed")}</p>
      <Button variant="outline" size="sm" onClick={() => void load()}>
        {t("channels.discordApp.retry")}
      </Button>
    </div>
  );
  const errorLine = actionError && <p className="text-aux text-destructive-fg">{actionError}</p>;

  return (
    <div className="space-y-8">
      <Section className="gap-3">
        <SectionHeader>
          <SectionHeading>
            <SectionTitle className="text-ui font-medium">
              {t("channels.discordApp.servers")}
            </SectionTitle>
          </SectionHeading>
          <SectionActions>{addButton}</SectionActions>
        </SectionHeader>
        {servers !== null && servers.length === 0 && !loadError ? (
          <div className="rounded-12 border border-dashed border-border-strong px-4 py-8 text-center text-ui text-muted-foreground">
            {t("channels.discordApp.empty")}
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {servers?.map((server) => (
              <li key={server.serverId} className="grid">
                <Card className="flex-row items-center gap-3 p-3">
                  <Mark name={server.serverName || "?"} icon={server.serverIcon} />
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
                    {server.serverName || server.serverId}
                  </span>
                  {removing === server.serverId ? (
                    <span className="text-aux text-muted-foreground">
                      {t("channels.discordApp.removing")}
                    </span>
                  ) : (
                    serverMenu(server)
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
        {loadFailed}
        {errorLine}
        {servers !== null && <p className="text-aux text-muted-foreground">{hint}</p>}
      </Section>
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-destructive hover:text-destructive"
          onClick={onDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? t("common.disconnecting") : t("channels.discordApp.disconnect")}
        </Button>
      </div>
    </div>
  );
}

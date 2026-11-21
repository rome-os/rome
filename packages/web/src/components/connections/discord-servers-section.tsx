import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** A server and an account bound to this Rome, as the Discord bot's Worker lists them. */
interface DiscordServer {
  serverId: string;
  serverName: string;
  createdAt: number;
}
interface DiscordAccount {
  userId: string;
  createdAt: number;
  name?: string;
}

const BASE = "/api/connections/discord-app";

async function readError(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : null;
}

/**
 * The servers Rome's Discord bot was added to, under its connected card: one
 * row each with Remove, Add to server, and the guardian's Discord accounts.
 * Adding happens on Discord's own page, in a new tab; the list reads again
 * when the guardian comes back to this one.
 */
export function DiscordServersSection() {
  const { t } = useTranslation("settings");
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
      const data = (await response.json()) as { servers: DiscordServer[]; users: DiscordAccount[] };
      setServers(data.servers);
      setAccounts(data.users);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Discord's page runs in another tab: coming back reads the list again.
    const again = () => {
      if (document.visibilityState === "visible") void load();
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
    // Opened in the click, before the link is known, so no popup blocker stops it.
    const tab = window.open("", "_blank");
    setAdding(true);
    try {
      const response = await fetch(`${BASE}/install-link`, { method: "POST" });
      if (!response.ok) throw new Error((await readError(response)) ?? "");
      const { url } = (await response.json()) as { url: string };
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (error) {
      tab?.close();
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

  const dateOf = (ms: number) =>
    ms > 0 ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h4 className="text-aux font-medium text-foreground">{t("channels.discordApp.servers")}</h4>
        {loadError ? (
          <div className="flex items-center gap-2">
            <p className="text-aux text-destructive-fg">{t("channels.discordApp.loadFailed")}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("channels.discordApp.retry")}
            </Button>
          </div>
        ) : servers === null ? null : servers.length === 0 ? (
          <p className="text-aux text-muted-foreground">{t("channels.discordApp.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-4 border border-border">
            {servers.map((server) => (
              <li key={server.serverId} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                  {server.serverName || server.serverId}
                </span>
                <span className="text-aux text-muted-foreground">{dateOf(server.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(server)}
                  disabled={removing !== null}
                >
                  {removing === server.serverId
                    ? t("channels.discordApp.removing")
                    : t("channels.discordApp.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" onClick={() => void addToServer()} disabled={adding}>
          {t("channels.discordApp.add")}
        </Button>
        {actionError && <p className="text-aux text-destructive-fg">{actionError}</p>}
      </div>
      {accounts.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-aux font-medium text-foreground">
            {t("channels.discordApp.accounts")}
          </h4>
          <ul className="space-y-1">
            {accounts.map((account) => (
              <li key={account.userId} className="flex items-center gap-3 text-ui">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {account.name ?? `…${account.userId.slice(-4)}`}
                </span>
                <span className="text-aux text-muted-foreground">{dateOf(account.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-aux text-muted-foreground">{t("channels.discordApp.howTo")}</p>
    </div>
  );
}

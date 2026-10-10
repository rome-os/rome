import "./styles.css";
import { useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAppApi, navigateRome, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import {
  Check,
  CircleAlert,
  ExternalLink,
  Loader2,
  LogIn,
  Lock,
  PlugZap,
  Plus,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppGlyph } from "@/components/AppGlyph";
// Side-effect import: the top-level defineComponent() in connect-card registers
// the inline "connect-card" component into this bundle's SDK registry, so the
// host can mount it when connector_connect returns renderComponent. One card
// serves both brokers — it selects the Rome Cloud (Rome-managed) or Composio flow
// by toolkit via its Credential-status adapter.
import "@/connect-card";
// Side-effect import: registers the inline "login-card" component (the sign-in
// card connector_login renders when no Composio key is saved) into this
// bundle's SDK registry.
import "@/login-card";
import { useComposioLogin } from "@/lib/use-composio-login";
import { readApiResponse, requiresComposioSignIn } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  buildConnectionViews,
  CATALOG,
  CATALOG_BY_SLUG,
  ROME_MANAGED_CATALOG,
  titleCase,
  type CatalogEntry,
  type ConnectedAccount,
  type ConnectionView,
} from "@/lib/connections";

function openConnectionSettings() {
  navigateRome({ path: "settings", tab: "connections" });
}

interface StatusPayload {
  appId: string;
  version: string;
  hasKey: boolean;
  webhookRegistered: boolean;
  relayConfigured: boolean;
}

type Notice = { kind: "info" | "error"; text: string } | null;

async function fetchStatus(): Promise<StatusPayload> {
  const res = await fetchAppApi("status");
  if (!res.ok) throw new Error(`status: ${res.status}`);
  return (await res.json()) as StatusPayload;
}

async function fetchAccounts(): Promise<ConnectedAccount[]> {
  const res = await fetchAppApi("connectors");
  const body = await readApiResponse<{ items: ConnectedAccount[] }>(
    res,
    `Could not load your connectors (${res.status})`,
  );
  return body.items;
}

// One client for the session. Defaults apply to both UI-state queries below:
// - retry:false — a failure surfaces in the notice bar immediately instead of
//   leaving the page skeletoned through retry backoff (isPending gates first paint).
// - gcTime:0 — evict on unmount so auth-sensitive UI is never painted from a
//   snapshot taken before auth changed elsewhere (another tab, CLI login/logout).
// Window-focus refetch (on by default) picks up OAuth round-trips that finish in
// another tab.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

export default function ComposioApp({ bootstrap }: { bootstrap: RomeAppBootstrap }) {
  void bootstrap;
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionsPage />
    </QueryClientProvider>
  );
}

function ConnectionsPage() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [registeringWebhook, setRegisteringWebhook] = useState(false);
  const [authorizationRejected, setAuthorizationRejected] = useState(false);

  const statusQuery = useQuery({ queryKey: ["status"], queryFn: fetchStatus });
  const accountsQuery = useQuery({
    queryKey: ["connectors"],
    queryFn: fetchAccounts,
    enabled: statusQuery.data?.hasKey === true,
  });

  const hasKey = statusQuery.data?.hasKey ?? false;
  const requiresSignIn = authorizationRejected || requiresComposioSignIn(accountsQuery.error);
  const signedIn = hasKey && !requiresSignIn && accountsQuery.data !== undefined;
  const accounts = requiresSignIn ? [] : (accountsQuery.data ?? []);

  // A later transport failure cannot make a rejected session valid again.
  useEffect(() => {
    if (requiresComposioSignIn(accountsQuery.error)) setAuthorizationRejected(true);
  }, [accountsQuery.error]);

  const reportError = useCallback((err: unknown) => {
    if (requiresComposioSignIn(err)) {
      setAuthorizationRejected(true);
      setNotice(null);
      return;
    }
    setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
  }, []);

  // The connector callback redirects back with ?connector=<slug>&status=<status>;
  // confirm only on an active result (a declined/failed round-trip must not read
  // as success), then strip just those params so other query state and reloads
  // are unaffected.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connector = params.get("connector");
    if (!connector) return;
    const name = CATALOG_BY_SLUG.get(connector.toLowerCase())?.name ?? titleCase(connector);
    const ok = (params.get("status") ?? "active").toUpperCase() === "ACTIVE";
    setNotice(
      ok
        ? { kind: "info", text: `${name} connected.` }
        : { kind: "error", text: `Couldn't finish connecting ${name} — try again.` },
    );
    params.delete("connector");
    params.delete("status");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, []);

  const connect = useCallback(
    async (slug: string) => {
      setNotice(null);
      setBusySlug(slug);
      try {
        const res = await fetchAppApi("connectors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: slug }),
        });
        const body = await readApiResponse<{
          authorizationUrl?: string;
          alreadyConnected?: boolean;
          message?: string;
        }>(res, `connectors: ${res.status}`);
        if (body.alreadyConnected) {
          await qc.invalidateQueries({ queryKey: ["connectors"] });
          setNotice({ kind: "info", text: "Already connected." });
        } else if (body.authorizationUrl) {
          window.open(body.authorizationUrl, "_blank", "noopener,noreferrer");
          setNotice({ kind: "info", text: "Authorize the app in the new tab, then come back." });
        } else {
          setNotice({
            kind: "error",
            text: "Couldn't start the connection — no authorization URL was returned.",
          });
        }
      } catch (err) {
        reportError(err);
      } finally {
        setBusySlug(null);
      }
    },
    [qc, reportError],
  );

  const disconnect = useCallback(
    async (slug: string) => {
      setNotice(null);
      setBusySlug(slug);
      try {
        const res = await fetchAppApi(`connectors/${encodeURIComponent(slug)}`, {
          method: "DELETE",
        });
        await readApiResponse(res, `disconnect: ${res.status}`);
        await qc.invalidateQueries({ queryKey: ["connectors"] });
        setNotice({ kind: "info", text: "Disconnected." });
      } catch (err) {
        reportError(err);
      } finally {
        setBusySlug(null);
      }
    },
    [qc, reportError],
  );

  const signOut = useCallback(async () => {
    setNotice(null);
    try {
      const res = await fetchAppApi("logout", { method: "POST" });
      if (!res.ok) throw new Error(`logout: ${res.status}`);
      setAuthorizationRejected(false);
      // Mirror onSignedIn: flip hasKey=false at once so the signed-in row and
      // unlocked connect buttons disappear immediately rather than lingering
      // until the status refetch lands (or indefinitely if it fails), and drop
      // the cached connections so none stay on screen. Then revalidate.
      qc.setQueryData<StatusPayload>(["status"], (prev) =>
        prev ? { ...prev, hasKey: false, webhookRegistered: false } : prev,
      );
      qc.setQueryData<ConnectedAccount[]>(["connectors"], []);
      await qc.invalidateQueries();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [qc]);

  const registerWebhook = useCallback(async () => {
    setNotice(null);
    setRegisteringWebhook(true);
    try {
      const res = await fetchAppApi("webhook/register", { method: "POST" });
      await readApiResponse(res, `webhook/register: ${res.status}`);
      await qc.invalidateQueries({ queryKey: ["status"] });
      setNotice({ kind: "info", text: "Webhook registered. Event delivery is ready." });
    } catch (err) {
      reportError(err);
    } finally {
      setRegisteringWebhook(false);
    }
  }, [qc, reportError]);

  const onSignedIn = useCallback(() => {
    setAuthorizationRejected(false);
    setNotice(null);
    // Reset the rejected session's accounts before validating the new key.
    qc.setQueryData<StatusPayload>(["status"], (prev) => (prev ? { ...prev, hasKey: true } : prev));
    // resetQueries, not removeQueries: connectors has a mounted observer, so it
    // must be reset to its pristine pending state (and refetched) — removeQueries
    // leaves the active observer serving the stale [] until the next focus/remount.
    void qc.resetQueries({ queryKey: ["connectors"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
    // The Rome-managed bridge reconcile runs inside useComposioLogin (shared by
    // every sign-in path) before this fires, so the connectors refetch above
    // already reflects a freshly bridged GitHub account.
  }, [qc]);

  const connections = buildConnectionViews(accounts);
  // Rome-managed providers (e.g. GitHub) are brokered by Rome's own integration,
  // so they get a managed card and never a Composio connect — split them out of
  // both the Composio "Your connectors" list and the connectable catalog.
  const composioConnections = connections.filter((c) => !c.romeManaged);
  const managedConnectionSlugs = new Set(
    connections.filter((c) => c.romeManaged && !c.needsAttention).map((c) => c.slug.toLowerCase()),
  );
  const connectedSlugs = new Set(composioConnections.map((c) => c.slug.toLowerCase()));
  const available = CATALOG.filter((e) => !e.romeManaged && !connectedSlugs.has(e.slug));
  const attentionCount = composioConnections.filter((c) => c.needsAttention).length;

  // Action feedback wins over load errors; either renders in the one notice bar.
  const loadError = statusQuery.error ?? accountsQuery.error;
  const shownNotice = requiresSignIn
    ? null
    : (notice ?? (loadError ? { kind: "error" as const, text: loadError.message } : null));

  // While the accounts list (a Composio round trip) is loading for a signed-in
  // owner, both grids show placeholders — rendering the catalog as "available"
  // before the list arrives would let cards jump between sections.
  const accountsLoading = hasKey && !requiresSignIn && accountsQuery.isPending;

  return (
    <main className="mx-auto max-w-[1080px] px-8 py-8">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Connectors</h1>
        <p className="mt-3 max-w-[60ch] text-base leading-relaxed text-muted-foreground">
          Connect the apps Rome can work in for you. Your Rome apps can read and act in connected
          apps on your behalf.
        </p>
      </header>

      {shownNotice && (
        <div
          className={
            shownNotice.kind === "error"
              ? "mb-6 rounded-8 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "mb-6 rounded-8 border border-success-border bg-success-bg px-3 py-2 text-sm text-success-fg"
          }
        >
          {shownNotice.text}
        </div>
      )}

      {statusQuery.isPending ? (
        // Signed-in state unknown until the first (local, fast) status response —
        // painting either the sign-in gate or the signed-in row here would flash
        // the wrong state.
        <PageSkeleton />
      ) : (
        <>
          {signedIn ? (
            <SignedInRow
              webhookRegistered={statusQuery.data?.webhookRegistered ?? false}
              relayConfigured={statusQuery.data?.relayConfigured ?? false}
              registeringWebhook={registeringWebhook}
              onRegisterWebhook={registerWebhook}
              onSignOut={signOut}
            />
          ) : hasKey && !requiresSignIn ? (
            <div className="mb-8 flex items-center gap-3 text-ui text-muted-foreground">
              {accountsQuery.isPending ? (
                <span>Checking Composio authorization…</span>
              ) : (
                <>
                  <span>Could not check Composio authorization</span>
                  <Button variant="outline" onClick={() => void accountsQuery.refetch()}>
                    Retry
                  </Button>
                </>
              )}
            </div>
          ) : (
            <SignInGate onSignedIn={onSignedIn} requiresSignIn={requiresSignIn} />
          )}

          {ROME_MANAGED_CATALOG.length > 0 && (
            <>
              <SectionLabel>Managed by Rome</SectionLabel>
              <CardGrid className="mb-12">
                {ROME_MANAGED_CATALOG.map((e) => (
                  <ManagedCard
                    key={e.slug}
                    entry={e}
                    connected={managedConnectionSlugs.has(e.slug.toLowerCase())}
                  />
                ))}
              </CardGrid>
            </>
          )}

          <SectionLabel
            note={
              composioConnections.length === 0
                ? undefined
                : `${composioConnections.length - attentionCount} connected${
                    attentionCount > 0 ? ` · ${attentionCount} needs you` : ""
                  }`
            }
          >
            Your connectors
          </SectionLabel>
          {accountsLoading ? (
            <CardGrid className="mb-12">
              {[0, 1, 2].map((i) => (
                <CardSkeleton key={i} />
              ))}
            </CardGrid>
          ) : composioConnections.length === 0 ? (
            <p className="mb-12 text-sm text-muted-foreground">
              {signedIn
                ? "No connectors added yet — add one below."
                : hasKey && !requiresSignIn
                  ? "Could not load connectors"
                  : "Sign in to see and add connectors."}
            </p>
          ) : (
            <CardGrid className="mb-12">
              {composioConnections.map((c) => (
                <ConnectedCard
                  key={`${c.slug}-${c.name}`}
                  conn={c}
                  busy={busySlug === c.slug}
                  onReconnect={() => connect(c.slug)}
                  onDisconnect={() => disconnect(c.slug)}
                />
              ))}
            </CardGrid>
          )}

          <SectionLabel>Add a connector</SectionLabel>
          <CardGrid>
            {accountsLoading
              ? CATALOG.map((e) => <CardSkeleton key={e.slug} />)
              : available.map((e) => (
                  <AvailableCard
                    key={e.slug}
                    entry={e}
                    locked={!signedIn}
                    busy={busySlug === e.slug}
                    onConnect={() => connect(e.slug)}
                  />
                ))}
          </CardGrid>
        </>
      )}
    </main>
  );
}

function CardGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4", className)}>
      {children}
    </div>
  );
}

function CardSkeleton() {
  return <div className="h-44 animate-pulse rounded-12 border border-border bg-card shadow-1" />;
}

function PageSkeleton() {
  return (
    <div aria-hidden>
      <div className="mb-10 h-[92px] animate-pulse rounded-12 border border-border bg-card shadow-1" />
      <div className="mb-4 h-4 w-32 animate-pulse rounded-4 bg-muted" />
      <CardGrid>
        {[0, 1, 2].map((i) => (
          <CardSkeleton key={i} />
        ))}
      </CardGrid>
    </div>
  );
}

function StatusTag({ tone }: { tone: "connected" | "attention" }) {
  if (tone === "attention") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-bg px-2.5 py-0.5 text-xs font-semibold text-warning-fg">
        <CircleAlert size={13} strokeWidth={2.25} />
        Needs sign-in
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success-border bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg">
      <Check size={13} strokeWidth={2.25} />
      Connected
    </span>
  );
}

function CardShell({ children, dimmed }: { children: React.ReactNode; dimmed?: boolean }) {
  return (
    <div
      className={`flex flex-col gap-3.5 rounded-12 border border-border bg-card p-5 shadow-1 transition-opacity ${
        dimmed ? "opacity-60" : ""
      }`}
    >
      {children}
    </div>
  );
}

function ConnectedCard({
  conn,
  busy,
  onReconnect,
  onDisconnect,
}: {
  conn: ConnectionView;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const needs = conn.needsAttention;
  const [confirming, setConfirming] = useState(false);
  return (
    <CardShell>
      <div className="flex items-center gap-3">
        <AppGlyph glyph={conn.glyph} />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold leading-tight text-foreground">{conn.name}</div>
          <div className="mt-1.5">
            <StatusTag tone={needs ? "attention" : "connected"} />
          </div>
        </div>
      </div>
      <div
        className={`text-sm leading-normal ${needs ? "text-foreground" : "text-muted-foreground"}`}
      >
        {confirming
          ? `Disconnect ${conn.name}? Rome will lose access until you reconnect.`
          : needs
            ? `Rome can't reach ${conn.name} until you sign in again.`
            : conn.scope}
      </div>
      <div className="mt-auto pt-1">
        {confirming ? (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="destructive" className="flex-1" onClick={onDisconnect} disabled={busy}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        ) : needs ? (
          <div className="flex gap-2">
            <Button variant="default" className="flex-1" onClick={onReconnect} disabled={busy}>
              <LogIn />
              {busy ? "Opening…" : "Sign in again"}
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              <Unplug />
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            <Unplug />
            Disconnect
          </Button>
        )}
      </div>
    </CardShell>
  );
}

function AvailableCard({
  entry,
  locked,
  busy,
  onConnect,
}: {
  entry: CatalogEntry;
  locked: boolean;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <CardShell dimmed={locked}>
      <div className="flex items-center gap-3">
        <AppGlyph glyph={entry.glyph} />
        <div className="text-base font-semibold text-foreground">{entry.name}</div>
      </div>
      <div className="text-sm leading-normal text-muted-foreground">{entry.scope}</div>
      <div className="mt-auto pt-1">
        {locked ? (
          <Button variant="secondary" className="w-full" disabled>
            <Lock />
            Sign in to connect
          </Button>
        ) : (
          <Button variant="secondary" className="w-full" onClick={onConnect} disabled={busy}>
            <Plus />
            {busy ? "Opening…" : "Connect"}
          </Button>
        )}
      </div>
    </CardShell>
  );
}

/** A Rome-brokered provider (e.g. GitHub). Rome's own integration owns the
    connection — connecting and disconnecting happen in Settings → Connections,
    not here — so this card never starts a Composio OAuth flow. It reflects the
    bridged connection's state and routes the owner to the one place that manages
    it, so every entry point converges on the same integration. */
function ManagedCard({ entry, connected }: { entry: CatalogEntry; connected: boolean }) {
  return (
    <CardShell>
      <div className="flex items-center gap-3">
        <AppGlyph glyph={entry.glyph} />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold leading-tight text-foreground">{entry.name}</div>
          <div className="mt-1.5">
            {connected ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-success-border bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg">
                <Check size={13} strokeWidth={2.25} />
                Connected via Rome
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                <ShieldCheck size={13} strokeWidth={2.25} />
                Managed by Rome
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="text-sm leading-normal text-muted-foreground">
        {connected
          ? `${entry.name} is connected through Rome — manage it in Settings.`
          : `Connect ${entry.name} in Settings → Connections; Rome wires it up here automatically.`}
      </div>
      <div className="mt-auto pt-1">
        <Button variant="secondary" className="w-full" onClick={openConnectionSettings}>
          <ExternalLink />
          Manage in Settings
        </Button>
      </div>
    </CardShell>
  );
}

/** Sign-in gate. Logging in to Composio is the one prerequisite to connecting
    apps; "Composio" stays a small powered-by line, not the headline. */
function SignInGate({
  onSignedIn,
  requiresSignIn,
}: {
  onSignedIn: () => void;
  requiresSignIn: boolean;
}) {
  const { phase, loginUrl, message: msg, start, cancel } = useComposioLogin(onSignedIn);

  return (
    <div className="mb-10 flex flex-wrap items-center gap-5 rounded-12 border border-border bg-card px-6 py-5 shadow-1">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <PlugZap size={22} strokeWidth={1.75} />
      </div>
      <div className="min-w-[240px] flex-1">
        <div className="text-base font-semibold leading-tight text-foreground">
          {requiresSignIn
            ? "Composio authorization is no longer valid"
            : "Sign in to add connectors"}
        </div>
        <div className="mt-1 max-w-[52ch] text-sm leading-normal text-muted-foreground">
          {requiresSignIn
            ? "Sign in again to use your connectors."
            : "One sign-in lets Rome securely link the connectors below. Your accounts stay yours — you can disconnect any of them anytime."}
        </div>
        {msg && <div className="mt-2 text-sm text-muted-foreground">{msg}</div>}
      </div>
      <div className="flex flex-col items-end gap-2">
        {phase === "awaiting" ? (
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Loader2 size={16} className="animate-spin" />
              Waiting for authorization…
            </div>
            <div className="flex items-center gap-3">
              {loginUrl && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  onClick={() => window.open(loginUrl, "_blank", "noopener,noreferrer")}
                >
                  Reopen sign-in tab
                </button>
              )}
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={cancel}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <Button onClick={start} disabled={phase !== "idle"}>
            <LogIn />
            {phase === "starting" ? "Starting…" : requiresSignIn ? "Sign in again" : "Sign in"}
          </Button>
        )}
        <span className="font-mono text-aux text-muted-foreground">Secured by Composio</span>
      </div>
    </div>
  );
}

function SignedInRow({
  webhookRegistered,
  relayConfigured,
  registeringWebhook,
  onRegisterWebhook,
  onSignOut,
}: {
  webhookRegistered: boolean;
  relayConfigured: boolean;
  registeringWebhook: boolean;
  onRegisterWebhook: () => void;
  onSignOut: () => void;
}) {
  const webhookReady = relayConfigured && webhookRegistered;
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-sm text-muted-foreground">
      <ShieldCheck size={16} strokeWidth={2} className="text-success-fg" />
      <span>Signed in — you can add connectors below.</span>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
          webhookReady
            ? "border-success-border bg-success-bg text-success-fg"
            : "border-destructive/30 bg-destructive/10 text-destructive",
        )}
      >
        {webhookReady ? (
          <Check size={13} strokeWidth={2.25} />
        ) : (
          <CircleAlert size={13} strokeWidth={2.25} />
        )}
        {webhookReady
          ? "Webhook registered"
          : relayConfigured
            ? "Webhook needs registration"
            : "Webhook relay unavailable"}
      </span>
      <button
        type="button"
        onClick={onRegisterWebhook}
        disabled={!relayConfigured || registeringWebhook}
        className="underline underline-offset-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {registeringWebhook
          ? "Registering…"
          : webhookRegistered
            ? "Re-register"
            : "Register webhook"}
      </button>
      <button
        type="button"
        onClick={onSignOut}
        className="underline underline-offset-2 hover:text-foreground"
      >
        Sign out
      </button>
    </div>
  );
}

function SectionLabel({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="mb-4 flex items-baseline gap-2.5">
      <span className="font-mono text-aux uppercase text-muted-foreground">{children}</span>
      {note && <span className="font-mono text-aux text-muted-foreground/70">{note}</span>}
    </div>
  );
}

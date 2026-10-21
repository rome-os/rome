import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  defineComponent,
  fetchAppApi,
  navigateRome,
  type AppComponentContext,
} from "@rome-os/app-web-sdk";
import {
  CATALOG_BY_SLUG,
  isRomeSettingsLink,
  romeManagedGrantsUsable,
  titleCase,
  type ConnectedAccount,
} from "@/lib/connections";
import { wasDismissed } from "@/lib/interaction";

// The single inline "connect an app" card the connector_connect action renders
// into the chat transcript. It handles BOTH brokers behind one componentId,
// selecting the flow by toolkit: a Rome-managed toolkit (github, slack — brokered
// by Rome's own Rome Cloud OAuth) drives core's /api/integrations flow, while a
// Composio toolkit drives the connector app's own `connectors` backend. Both
// learn completion by polling from the browser (the OAuth callback is
// request-host-coupled, which is exactly why this lives in a browser-originated
// component and not in the action) and both resume the agent through the same
// ctx.host.submit / dismiss contract.
//
// The "how do I learn auth completed?" difference is the ONLY difference between
// the two flows, so it's factored into a CredentialStatusAdapter (below): the
// card renders one shell (checking / idle / authorizing / connected / dismissed /
// unavailable + a Settings fallback) and delegates start + completion-detection
// to whichever adapter the toolkit selects. Reaching a core endpoint from an app
// bundle is sound because apps mount in the host's Shadow DOM (same page origin,
// host cookies) — the same way startChat() posts to /api/chat/sessions.

const POLL_INTERVAL_MS = 2500;
const POLL_ATTEMPTS = 48; // ~2 min for the owner to authorize in the opened tab

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Credential-status adapter
//
// The abstraction "how do I learn auth completed (and how do I start it)?" with
// two implementations. Both are async and fail-soft: a check that can't tell
// (network, non-OK, parse) returns "not connected yet" so the card keeps polling
// rather than reporting a false success.
// ---------------------------------------------------------------------------

interface Availability {
  available: boolean;
  // Only set when available === false: why this provider can't be connected here.
  unavailableReason: string | null;
}

type StartResult =
  | { kind: "already_connected" }
  | { kind: "authorize"; authorizationUrl: string }
  | { kind: "error"; message: string };

interface CredentialStatusAdapter {
  // Whether this provider can be connected inline at all. Rome-managed providers
  // may be unavailable (Rome Cloud not configured); Composio is always available
  // once the action's sign-in gate has passed.
  checkAvailability(): Promise<Availability>;
  // Begin the OAuth round-trip (returns the authorize URL to open, or reports the
  // connection already exists), without opening the tab itself — the card does.
  start(): Promise<StartResult>;
  // Poll: has the connection reached "connected"/ACTIVE?
  isConnected(): Promise<boolean>;
}

interface ConnectionStatus {
  service: string;
  grants: Record<string, string>;
  connect: { url: string | null; available: boolean; unavailableReason: string | null } | null;
}

// GitHub/Slack-style: Rome brokers the OAuth through its own integration (Rome Cloud).
// The connector server can't see Rome Cloud's connection state, so the status check
// and start URL both come from core's registry-native /api/connections list, read
// in the browser.
function createRomeManagedAdapter(slug: string, name: string): CredentialStatusAdapter {
  // The connect URL learned from checkAvailability, reused by start() so we don't
  // re-fetch mid-flow. Rome-managed authorize URLs are stable per provider.
  let connectUrl: string | null = null;

  async function loadStatus(): Promise<ConnectionStatus | null> {
    try {
      const res = await fetch("/api/connections", { credentials: "include", cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { connections?: ConnectionStatus[] };
      return body.connections?.find((c) => c.service === slug) ?? null;
    } catch {
      return null;
    }
  }

  return {
    async checkAvailability() {
      const status = await loadStatus();
      if (status?.connect && !status.connect.available) {
        return {
          available: false,
          unavailableReason:
            status.connect.unavailableReason ?? `${name} can't be connected on this instance.`,
        };
      }
      connectUrl = status?.connect?.url ?? null;
      return { available: true, unavailableReason: null };
    },
    async start() {
      if (!connectUrl) {
        return {
          kind: "error",
          message: `Couldn't find the ${name} authorization link. Open Settings → Connections to connect.`,
        };
      }
      return { kind: "authorize", authorizationUrl: connectUrl };
    },
    async isConnected() {
      const status = await loadStatus();
      return romeManagedGrantsUsable(status?.grants);
    },
  };
}

interface StartResponse {
  authorizationUrl?: string;
  alreadyConnected?: boolean;
  message?: string;
}

function isActiveFor(items: ConnectedAccount[], toolkit: string): boolean {
  const slug = toolkit.toLowerCase();
  return items.some(
    (a) => a.toolkitSlug.toLowerCase() === slug && a.status.toUpperCase() === "ACTIVE",
  );
}

// Composio-style: the connector app owns the connection, so it drives its own
// `connectors` backend — POST to start the OAuth round-trip, GET to poll until
// the toolkit reports ACTIVE. Same backend the dashboard uses.
function createComposioAdapter(slug: string): CredentialStatusAdapter {
  return {
    async checkAvailability() {
      // Sign-in is gated by the action before this card is ever rendered, and any
      // toolkit reaching here is in the supported catalog, so Composio connect is
      // always available at this point.
      return { available: true, unavailableReason: null };
    },
    async start() {
      const res = await fetchAppApi("connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: slug, origin: "webchat" }),
      });
      const body = (await res.json().catch(() => ({}))) as StartResponse;
      if (!res.ok) {
        return {
          kind: "error",
          message: body.message ?? `Couldn't start the connection (HTTP ${res.status}).`,
        };
      }
      if (body.alreadyConnected) return { kind: "already_connected" };
      if (!body.authorizationUrl) {
        return { kind: "error", message: "Composio didn't return an authorization link." };
      }
      return { kind: "authorize", authorizationUrl: body.authorizationUrl };
    },
    async isConnected() {
      try {
        const res = await fetchAppApi("connectors");
        if (!res.ok) return false;
        const body = (await res.json()) as { items?: ConnectedAccount[] };
        return isActiveFor(body.items ?? [], slug);
      } catch {
        return false;
      }
    },
  };
}

// Rome-managed slugs select the Rome Cloud flow; everything else is Composio. The
// catalog's `romeManaged` flag is the single source of truth (the server-side
// twin is shared.ts's ROME_MANAGED_TOOLKITS), so a provider added there routes
// here without touching this card.
function createAdapter(slug: string, name: string): CredentialStatusAdapter {
  const romeManaged = CATALOG_BY_SLUG.get(slug.toLowerCase())?.romeManaged ?? false;
  return romeManaged
    ? createRomeManagedAdapter(slug.toLowerCase(), name)
    : createComposioAdapter(slug.toLowerCase());
}

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

type Phase =
  | "checking"
  | "idle"
  | "starting"
  | "authorizing"
  | "connected"
  | "dismissed"
  | "unavailable"
  | "error";

// A resolved instance is "connected" only if it actually submitted a result; a
// dismiss resolves as such and must read as "dismissed", never "connected".
function initialPhase(ctx: AppComponentContext): Phase {
  if (!ctx.host.resolved) return "checking";
  return wasDismissed(ctx.result) ? "dismissed" : "connected";
}

function ConnectCard({ ctx }: { ctx: AppComponentContext }) {
  const toolkit = typeof ctx.props.toolkit === "string" ? ctx.props.toolkit : "";
  const entry = CATALOG_BY_SLUG.get(toolkit.toLowerCase());
  const name = entry?.name ?? titleCase(toolkit);
  const scope = entry?.scope;

  const [phase, setPhase] = useState<Phase>(() => initialPhase(ctx));
  const [error, setError] = useState<string | null>(null);
  // The adapter is stable for the card's lifetime (toolkit doesn't change), so
  // build it once — its Rome-managed variant caches the connect URL across calls.
  const adapterRef = useRef<CredentialStatusAdapter | null>(null);
  if (!adapterRef.current && toolkit) {
    adapterRef.current = createAdapter(toolkit, name);
  }
  // Guards the two completion paths (auto-poll + manual "I've authorized") from
  // both calling submit, and stops a poll loop that outlives the unmounted card.
  const done = useRef(false);

  useEffect(() => {
    return () => {
      done.current = true;
    };
  }, []);

  function finish() {
    if (done.current) return;
    done.current = true;
    setPhase("connected");
    ctx.host.submit({ toolkit, status: "connected" }, `Connected ${name}`);
  }

  // On mount, ask the adapter whether this app is available and already connected
  // (the agent may have called connector_connect defensively). A connected app
  // resumes immediately; an unavailable one (Rome Cloud not configured) can't be
  // connected inline — say why and let the guardian dismiss or jump to Settings.
  useEffect(() => {
    if (ctx.host.resolved) return;
    const adapter = adapterRef.current;
    if (!adapter) {
      setPhase("idle");
      return;
    }
    let cancelled = false;
    void (async () => {
      const availability = await adapter.checkAvailability();
      if (cancelled || done.current) return;
      if (!availability.available) {
        setError(availability.unavailableReason ?? `${name} can't be connected on this instance.`);
        setPhase("unavailable");
        return;
      }
      if (await adapter.isConnected()) {
        if (cancelled || done.current) return;
        finish();
        return;
      }
      if (cancelled || done.current) return;
      setPhase("idle");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pollUntilConnected() {
    const adapter = adapterRef.current;
    if (!adapter) return;
    for (let i = 0; i < POLL_ATTEMPTS && !done.current; i++) {
      await sleep(POLL_INTERVAL_MS);
      if (await adapter.isConnected()) {
        finish();
        return;
      }
    }
    if (!done.current) {
      setError(
        `Didn't see ${name} finish connecting. Authorize in the opened tab, then check again.`,
      );
      setPhase("error");
    }
  }

  async function connect() {
    const adapter = adapterRef.current;
    if (!adapter || phase === "starting" || phase === "authorizing") return;
    setError(null);
    setPhase("starting");
    try {
      const result = await adapter.start();
      if (done.current) return;
      if (result.kind === "error") {
        setError(result.message);
        setPhase("error");
        return;
      }
      if (result.kind === "already_connected") {
        finish();
        return;
      }
      if (isRomeSettingsLink(result.authorizationUrl)) {
        // A Settings page needs the Rome session, so stay in this window; the
        // card re-checks the connection when the guardian comes back to chat.
        navigateRome({ path: "settings", tab: "connections" });
        setPhase("authorizing");
        return;
      }
      // Authorize in a new tab (not a full navigation) so the chat transcript and
      // this card survive the OAuth round-trip; the callback redeems server-side
      // in that tab and the poll below picks the connection up here.
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      setPhase("authorizing");
      void pollUntilConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function checkNow() {
    const adapter = adapterRef.current;
    if (!adapter) return;
    try {
      if (await adapter.isConnected()) {
        finish();
        return;
      }
      setError(`${name} isn't connected yet. Authorize in the opened tab, then check again.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (phase === "checking") {
    return (
      <div className="rounded-12 border border-border bg-surface p-4 text-sm text-muted-foreground">
        Checking {name}…
      </div>
    );
  }

  if (phase === "connected") {
    return (
      <div className="rounded-12 border border-border bg-surface p-4 text-sm text-foreground">
        {name} connected.
      </div>
    );
  }

  if (phase === "dismissed") {
    return (
      <div className="rounded-12 border border-border bg-surface p-4 text-sm text-muted-foreground">
        Connecting {name} was dismissed.
      </div>
    );
  }

  // Unavailable is a Rome-managed-only state (Rome Cloud not configured for this
  // provider): connecting inline is impossible, so offer the Settings fallback.
  if (phase === "unavailable") {
    return (
      <div className="rounded-12 border border-border bg-surface p-4">
        <span className="text-sm font-medium text-foreground">Connect {name}</span>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => ctx.host.dismiss()}
            className="rounded-8 border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-muted-foreground/50"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => navigateRome({ path: "settings", tab: "connections" })}
            className="rounded-8 bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-12 border border-border bg-surface p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">Connect {name}</span>
        {scope ? <span className="text-xs text-muted-foreground">{scope}</span> : null}
      </div>

      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {phase === "authorizing" ? "Waiting for you to authorize in the opened tab…" : ""}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => ctx.host.dismiss()}
            className="rounded-8 border border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-muted-foreground/50"
          >
            Dismiss
          </button>
          {phase === "authorizing" ? (
            <button
              type="button"
              onClick={checkNow}
              className="rounded-8 bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
            >
              I've authorized
            </button>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={phase === "starting" || !toolkit}
              className="rounded-8 bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {phase === "starting" ? "Starting…" : phase === "error" ? "Try again" : "Connect"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Registered at bundle load (top level) so the renderer is in the SDK registry
// before the host calls mountComponent for "connect-card".
defineComponent("connect-card", (container, ctx) => {
  const root = createRoot(container);
  root.render(<ConnectCard ctx={ctx} />);
  return () => root.unmount();
});

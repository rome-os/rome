import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Loader2, LogIn, PlugZap } from "lucide-react";
import { defineComponent, type AppComponentContext } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { useComposioLogin } from "@/lib/use-composio-login";
import { wasDismissed } from "@/lib/interaction";

// The inline "sign in to Composio" card the connector_login action renders when
// no Composio key is saved yet. This is NOT a user-facing "connection" — it's the
// internal Composio-account-broker step (account-wide sign-in) that must complete
// before the unified connect-card can authorize any Composio toolkit. It drives
// the same browser login the dashboard
// uses, then submits so the agent resumes and can connect toolkits. Login is
// request-host-coupled (the authorize tab opens in the owner's browser), which
// is exactly why it lives in a browser-originated component and not in the
// action. Sign-in is account-wide (not per-toolkit), so this card carries no
// toolkit — connector_login is the single sign-in surface and connector_connect
// points the agent here rather than rendering its own card.

function LoginCard({ ctx }: { ctx: AppComponentContext }) {
  // Track resolution locally (seeded from the host) and flip it synchronously
  // on success, so the signed-in view renders immediately and doesn't flash back
  // to the sign-in state if the card re-mounts before the host marks it resolved.
  // A dismiss also resolves the card, so success requires a non-dismiss result.
  const [signedIn, setSignedIn] = useState(() => ctx.host.resolved && !wasDismissed(ctx.result));
  const dismissed = ctx.host.resolved && !signedIn;

  const { phase, loginUrl, message, start, cancel } = useComposioLogin(() => {
    setSignedIn(true);
    // Signing in is only the prerequisite — no toolkit is connected yet. The
    // resume prompt is built verbatim from this payload, so it must spell out
    // the next step; otherwise the agent reads "signed_in" and wrongly reports a
    // toolkit as connected. The instruction drives the agent to (re-)invoke
    // connector_connect per toolkit, which then renders the connect card.
    ctx.host.submit(
      {
        status: "signed_in",
        nextStep:
          "Signed in to Composio. No toolkit is connected yet — call connector:connector_connect for each toolkit you want to connect to start its authorization.",
      },
      "Signed in to Composio",
    );
  });

  if (signedIn) {
    return (
      <div className="rounded-12 border border-border bg-surface p-4 text-sm text-foreground">
        Signed in to Composio.
      </div>
    );
  }

  if (dismissed) {
    return (
      <div className="rounded-12 border border-border bg-surface p-4 text-sm text-muted-foreground">
        Sign-in dismissed.
      </div>
    );
  }

  return (
    <div
      data-ui-typography="inline-card"
      className="rounded-12 border border-border bg-surface p-4"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          <PlugZap size={18} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <span className="text-ui font-medium text-foreground">Sign in to Composio</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One sign-in lets Rome connect apps on your behalf.
          </p>
          {message ? <p className="mt-2 text-xs text-destructive">{message}</p> : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {phase === "awaiting" ? "Waiting for you to authorize in the opened tab…" : ""}
        </span>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {phase === "awaiting" ? (
            <>
              {loginUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  compact
                  onClick={() => window.open(loginUrl, "_blank", "noopener,noreferrer")}
                >
                  Reopen tab
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" compact onClick={cancel}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                compact
                onClick={() => ctx.host.dismiss()}
              >
                Dismiss
              </Button>
              <Button
                type="button"
                size="sm"
                compact
                onClick={start}
                disabled={phase === "starting"}
              >
                {phase === "starting" ? (
                  <Loader2 size={14} data-icon="inline-start" className="animate-spin" />
                ) : (
                  <LogIn size={14} data-icon="inline-start" />
                )}
                {phase === "starting" ? "Starting…" : "Sign in"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Registered at bundle load (top level) so the renderer is in the SDK registry
// before the host calls mountComponent for "login-card".
defineComponent("login-card", (container, ctx) => {
  const root = createRoot(container);
  root.render(<LoginCard ctx={ctx} />);
  return () => root.unmount();
});

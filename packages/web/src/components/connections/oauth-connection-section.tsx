import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { ConnectionSlotCard } from "@/components/connection-slot-card";
import { SetupRenderer } from "@/components/setup/setup-renderer";
import { useSetup } from "@/components/setup/use-setup";
import { revokeConnectionGrant } from "@/lib/connections-api";
import { isElectronShell } from "@/lib/electron-shell";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";

/**
 * Hand the guardian to the broker.
 *
 * In the desktop shell that has to be the SYSTEM browser. The Electron window
 * is a fresh session with no keychain and no platform authenticator, so an
 * account whose second factor is a passkey or Touch ID cannot finish signing in
 * inside the app at all. `window.open` reaches the shell's
 * `setWindowOpenHandler`, which forwards the URL to the system browser and
 * denies the Electron window — no preload bridge needed.
 *
 * Everywhere else this stays a same-window navigation: a browser dashboard has
 * the user's own session and extensions already, and a new tab would be a
 * gratuitous change to a flow that works.
 */
function openAuthorizeUrl(url: string): void {
  if (isElectronShell()) {
    window.open(url);
    return;
  }
  window.location.assign(url);
}

/**
 * OAuth (Rome Cloud-brokered) connection slot as a full slot card — the
 * self-composing pattern (see `discord-connect-card.tsx`). Serves
 * github/google/slack.
 *
 * Connect/reconnect run through the generic conferral setup (#1611): the
 * setup's first state is `awaiting-redirect`, so clicking Connect hands the
 * guardian off to the broker; the return leg (handled by the OAuth callback
 * page) resumes the setup, which redeems and confers. There is NO bespoke
 * per-provider fetch logic here — the card renders from generic setup states and
 * an availability hint carried on the connection payload.
 *
 * - Unconnected → the frame's `+` bullets + privacy note, and a Connect
 *   button that starts the setup (→ redirect to the broker). While a
 *   returned setup finishes redeeming, the standard renderer narrates it.
 * - Unavailable (connect hint reports the host can't offer it) → a disabled
 *   Connect button with the reason.
 * - Connected → the account identity in the card header (avatar when present)
 *   with optional account detail, Disconnect + Reconnect.
 * - Degraded → the connected layout with an attention-toned "Access expired"
 *   subtitle and Reconnect promoted to the primary action.
 */
export function OAuthConnectionSection({
  card,
  slot,
  role,
  onRefresh,
  onFlash,
}: {
  card: ConnectionCard;
  slot: ConnectionSlot;
  role: "primary" | "secondary";
  onRefresh: () => void;
  onFlash: (message: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [disconnecting, setDisconnecting] = useState(false);

  const label = card.label;

  // The setup addresses the connection by id, or by the bare service name when
  // the guardian has never connected (the terminal conferral mints the row).
  const setup = useSetup({
    idOrService: slot.connectionId ?? card.service,
    grant: slot.grant ?? "",
    activeCid: slot.activeSetupCid,
    onDone: () => {
      void onRefresh();
    },
  });

  // Only auto-forward a redirect the guardian just initiated THIS session (the
  // click set `initiated`). A passive reattach to a parked `awaiting-redirect`
  // setup — the guardian abandoned the broker and navigated back — must NOT
  // bounce them out again; it renders a manual resume/cancel affordance instead,
  // so they can escape the flow.
  const initiatedRef = useRef(false);
  function beginConnect(force = false) {
    initiatedRef.current = true;
    setup.start(force);
  }

  const redirectUrl = setup.state?.status === "awaiting-redirect" ? setup.state.url : null;
  useEffect(() => {
    if (redirectUrl && initiatedRef.current) {
      initiatedRef.current = false;
      openAuthorizeUrl(redirectUrl);
    }
  }, [redirectUrl]);

  // Clear the initiation intent whenever a start settles anywhere that ISN'T the
  // broker hand-off (an error, or any non-redirect state), so a stale ref can't
  // let a LATER passive reattach auto-forward — keeping the guard robust against
  // future state-machine changes.
  useEffect(() => {
    if (setup.error || (setup.state && setup.state.status !== "awaiting-redirect")) {
      initiatedRef.current = false;
    }
  }, [setup.error, setup.state]);

  async function handleDisconnect() {
    if (!slot.connectionId || !slot.grant) return;
    setDisconnecting(true);
    const result = await revokeConnectionGrant(slot.connectionId, slot.grant);
    if (!result.ok) {
      onFlash(result.error || t("channels.disconnectFailedFallback"));
    } else {
      // Drop any stale terminal setup state so the unconnected card offers a
      // fresh Connect instead of the previous "done"/"cancelled" view.
      setup.reset();
      onRefresh();
    }
    setDisconnecting(false);
  }

  // Shown wherever a setup is parked at `awaiting-redirect` — the unconnected
  // card AND the connected one, because Reconnect parks there too and the
  // desktop shell no longer navigates the window away.
  const pendingRedirectControls = redirectUrl ? (
    <div className="space-y-2">
      <p className="text-ui text-muted-foreground">
        {t("connections.oauth.resumePending", { label })}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => openAuthorizeUrl(redirectUrl)}>
          {t("common.connect")}
        </Button>
        <Button variant="ghost" size="sm" disabled={setup.busy} onClick={setup.cancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  ) : null;

  // Unavailable on this host — render the unconnected card with a disabled
  // control and the reason.
  if (card.connect && !card.connect.available) {
    const reason = card.connect.unavailableReason ?? t("connections.oauth.unavailable");
    return (
      <ConnectionSlotCard
        service={card.service}
        slot={slot}
        state="unconnected"
        role={role}
        icon={<ConnectionBrandBadge connection={card.service} />}
      >
        <div>
          <Button variant="outline" disabled title={reason}>
            {t("common.connect")}
          </Button>
          <p className="mt-2 text-ui text-muted-foreground">{reason}</p>
        </div>
      </ConnectionSlotCard>
    );
  }

  if (slot.state === "unauthorized") {
    return (
      <ConnectionSlotCard
        service={card.service}
        slot={slot}
        state="unconnected"
        role={role}
        icon={<ConnectionBrandBadge connection={card.service} />}
      >
        {redirectUrl ? (
          // A setup parked at the broker hand-off. In a browser a
          // freshly-initiated redirect has already navigated away, so reaching
          // here is a passive reattach; in the desktop shell the hand-off went
          // to the system browser and this window stays put, so this is also
          // what the guardian looks at while they finish over there. Either way
          // the affordance is the same: reopen, or cancel and escape the flow.
          pendingRedirectControls
        ) : setup.state && setup.state.status !== "cancelled" ? (
          <SetupRenderer
            service={card.service}
            state={setup.state}
            busy={setup.busy}
            error={setup.error}
            onSubmit={setup.submit}
            onCancel={setup.cancel}
            onRetry={() => beginConnect(true)}
            labels={{ continue: t("common.connect") }}
          />
        ) : (
          <div>
            {setup.error && <p className="mb-2 text-ui text-destructive-fg">{setup.error}</p>}
            <Button
              disabled={setup.busy}
              aria-label={setup.busy ? t("common.connecting") : undefined}
              onClick={() => beginConnect()}
            >
              {setup.busy && <Spinner label={t("common.connecting")} />}
              {t("common.connect")}
            </Button>
          </div>
        )}
      </ConnectionSlotCard>
    );
  }

  // Conferred (authorized or degraded): the account identity is the card
  // title; avatar (when present) replaces the brand badge in the header. The
  // handle/email becomes the connected subtitle when it adds information
  // beyond the title.
  const expired = slot.state === "degraded";
  const accountLine = slot.identity ?? label;
  const accountDetail =
    (slot.display?.email !== accountLine ? slot.display?.email : null) ||
    (slot.display?.handle !== accountLine ? slot.display?.handle : null) ||
    undefined;
  const icon = slot.display?.avatarUrl ? (
    <Avatar className="size-9">
      <AvatarImage src={slot.display.avatarUrl} alt="" />
      <AvatarFallback>{accountLine.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  ) : (
    <ConnectionBrandBadge connection={card.service} />
  );

  const disconnectAction = (
    <Button
      variant="destructive"
      size="sm"
      disabled={disconnecting}
      aria-label={disconnecting ? t("common.disconnecting") : undefined}
      onClick={() => void handleDisconnect()}
    >
      {disconnecting && <Spinner size="sm" label={t("common.disconnecting")} />}
      {t("common.disconnect")}
    </Button>
  );

  return (
    <ConnectionSlotCard
      service={card.service}
      slot={slot}
      state="connected"
      role={role}
      icon={icon}
      identityTitle={accountLine}
      connectedSubtitle={accountDetail}
      action={disconnectAction}
    >
      <div className="space-y-2">
        {expired && (
          <p className="text-ui text-warning-fg">{t("connections.oauth.accessExpired")}</p>
        )}
        {pendingRedirectControls ?? (
          <Button
            variant={expired ? "default" : "outline"}
            size="sm"
            disabled={setup.busy}
            aria-label={setup.busy ? t("connections.oauth.reconnecting") : undefined}
            onClick={() => beginConnect(true)}
          >
            {setup.busy && <Spinner size="sm" label={t("connections.oauth.reconnecting")} />}
            {t("connections.oauth.reconnect")}
          </Button>
        )}
      </div>
    </ConnectionSlotCard>
  );
}

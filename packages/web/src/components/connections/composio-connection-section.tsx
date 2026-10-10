import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { ConnectionSlotCard } from "@/components/connection-slot-card";
import { runComposioLogin, runComposioLogout } from "@/lib/connection-connect";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";
import type { ComposioCliStatus } from "@/lib/provider-types";

/**
 * Composio ACCOUNT broker slot as a full slot card — the self-composing pattern.
 * The account login is a browser-leg flow: `runComposioLogin` opens the Composio
 * login URL and polls until signed in, then refreshes the integrations feed.
 * Connected → the frame's `✓` bullets + a Disconnect action in the header. The
 * install gate lives upstream (`buildConnectionCards` only emits this row when
 * the CLI is installed), so here we only ever render connect/disconnect.
 *
 * This surface may be retired soon; the conversion is intentionally minimal —
 * behaviour is unchanged from the original inline section.
 */
export function ComposioConnectionSection({
  card,
  slot,
  role,
  composio,
  onRefresh,
  onFlash,
}: {
  card: ConnectionCard;
  slot: ConnectionSlot;
  role: "primary" | "secondary";
  composio: ComposioCliStatus | null;
  onRefresh: () => void;
  onFlash: (message: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);

  const installed = Boolean(composio?.installed);
  const loggedIn = Boolean(composio?.loggedIn);

  async function connect() {
    setPending("connect");
    try {
      const result = await runComposioLogin({
        onLoginUrl: (loginUrl) => {
          const popup = window.open(loginUrl, "_blank", "noopener,noreferrer");
          if (popup) popup.opener = null;
        },
      });
      if (!result.ok) {
        onFlash(result.error);
        return;
      }
      onRefresh();
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    setPending("disconnect");
    try {
      const result = await runComposioLogout();
      if (!result.ok) {
        onFlash(result.error);
        return;
      }
      onRefresh();
    } finally {
      setPending(null);
    }
  }

  if (!installed) {
    return (
      <ConnectionSlotCard
        service={card.service}
        slot={slot}
        state="unconnected"
        role={role}
        icon={<ConnectionBrandBadge connection={card.service} />}
      >
        <p className="text-ui text-muted-foreground">{t("connections.composio.unavailable")}</p>
      </ConnectionSlotCard>
    );
  }

  const disconnectAction = loggedIn ? (
    <Button
      variant="destructive"
      size="sm"
      disabled={pending !== null}
      aria-label={pending === "disconnect" ? t("common.disconnecting") : undefined}
      onClick={() => void disconnect()}
    >
      {pending === "disconnect" && (
        <Spinner data-icon="inline-start" size="sm" label={t("common.disconnecting")} />
      )}
      {t("common.disconnect")}
    </Button>
  ) : undefined;

  return (
    <ConnectionSlotCard
      service={card.service}
      slot={slot}
      state={loggedIn ? "connected" : "unconnected"}
      role={role}
      icon={<ConnectionBrandBadge connection={card.service} />}
      action={disconnectAction}
    >
      {loggedIn ? null : (
        <div>
          <Button
            disabled={pending !== null || Boolean(composio?.loginPending)}
            aria-label={
              pending === "connect" || composio?.loginPending ? t("common.connecting") : undefined
            }
            onClick={() => void connect()}
          >
            {(pending === "connect" || composio?.loginPending) && (
              <Spinner data-icon="inline-start" label={t("common.connecting")} />
            )}
            {t("common.connect")}
          </Button>
        </div>
      )}
    </ConnectionSlotCard>
  );
}

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { User } from "lucide-react";
import { LINKABLE_SERVICES } from "@rome/api-types/account-agents";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { ConnectionSlotCard } from "@/components/connection-slot-card";
import {
  SetupRenderer,
  StandardSetupRenderer,
  type SetupRenderProps,
} from "@/components/setup/setup-renderer";
import { useSetup } from "@/components/setup/use-setup";
import type { ConnectionSlot } from "@/lib/connection-cards";
import { revokeConnectionGrant } from "@/lib/connections-api";

// Every Talk channel connects through the conferral setup: the card
// is a thin frame around `useSetup` (drives `/api/connections/:id/grants/:name/
// setup` + `/api/setups/:cid/input`) and the standard `SetupRenderer`. What used
// to be seven near-identical per-service cards (telegram bot / telegram user /
// whatsapp / discord / wechat / feishu / email) is a single component driven by
// the {@link ChannelConnectConfig} table below — the only things a channel
// varies are its grant name, a couple of copy keys, and (for Feishu) a
// genuinely custom QR-image setup renderer. That is the custom component; the
// generic card is the "standard renderer".

/**
 * The QR-bearing presenting view: the Feishu agent-ready setup publishes the
 * scannable QR as a data-url link so the payload stays semantically complete for
 * link-only renderers; this custom component renders that link as the image it
 * encodes and hands everything else to the standard renderer.
 */
function FeishuPresenting(props: SetupRenderProps) {
  const { state } = props;
  if (state.status !== "presenting") return <StandardSetupRenderer {...props} />;
  const qr = state.view.links?.find((link) => link.url.startsWith("data:image/"));
  if (!qr) return <StandardSetupRenderer {...props} />;
  const view = { ...state.view, links: state.view.links?.filter((link) => link !== qr) };
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <img
        src={qr.url}
        alt={qr.label}
        className="size-40 rounded-4 border border-border bg-white p-2"
      />
      <div className="min-w-0 flex-1">
        <StandardSetupRenderer {...props} state={{ status: "presenting", view }} />
      </div>
    </div>
  );
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface ChannelConnectConfig {
  /** Setup service id — addresses the setup (`useSetup`/`SetupRenderer`) and,
   *  by default, the brand badge and copy namespace. */
  service: string;
  /** Grant to address before a connection row exists; the terminal conferral
   *  mints the row, so this is the fallback when `slot.grant` is null. */
  defaultGrant: string;
  /** ConnectionSlotCard copy namespace (`connections.cards.<copyService>`) when
   *  it differs from the setup service — the telegram personal account presents
   *  under the telegram card. Defaults to `service`. */
  copyService?: string;
  /** i18n key for the success note shown under the connected header (the
   *  "linked as guardian" line). Omitted for services with no such note. */
  guardianLinkedKey?: string;
  /** Custom renderer for the `presenting` setup state — Feishu's QR image. */
  renderPresenting?: ComponentType<SetupRenderProps>;
  /** Header icon override; defaults to the service brand badge. */
  icon?: ReactNode;
  /** Copy key for the connected title when the slot has no folded identity. */
  identityFallbackKey?: string;
  /** Disconnect-failed fallback copy key; defaults to
   *  `channels.disconnectFailedFallback`. */
  disconnectFailedKey?: string;
  /** Whether this service exposes the shared conversation-settings surface. */
  conversationSettings?: boolean;
}

/** The personal-account glyph — a muted user circle instead of the brand badge,
 *  which the bot slot on the same card owns. */
function PersonalAccountIcon() {
  return (
    <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <User className="size-5" aria-hidden />
    </div>
  );
}

/** Per-service channel-card config, keyed by setup service id. `SlotEntry`
 *  resolves the telegram `session` slot to `telegram_user`; every other card is
 *  keyed by its service directly. */
export const CHANNEL_CONFIGS: Record<string, ChannelConnectConfig> = {
  telegram: {
    service: "telegram",
    defaultGrant: "bot",
  },
  telegram_user: {
    service: "telegram_user",
    copyService: "telegram",
    defaultGrant: "session",
    icon: <PersonalAccountIcon />,
    identityFallbackKey: "channels.telegramUser.fallbackName",
    disconnectFailedKey: "channels.telegramUser.disconnectFailedFallback",
  },
  whatsapp: {
    service: "whatsapp",
    defaultGrant: "session",
  },
  linkedin: {
    service: "linkedin",
    defaultGrant: "session",
  },
  discord: {
    service: "discord",
    defaultGrant: "bot",
    conversationSettings: true,
  },
  wechat: {
    service: "wechat",
    defaultGrant: "account",
    guardianLinkedKey: "channels.wechat.guardianLinked",
    conversationSettings: true,
  },
  wechat_user: {
    service: "wechat_user",
    copyService: "wechat",
    defaultGrant: "session",
    icon: <PersonalAccountIcon />,
    identityFallbackKey: "channels.wechatUser.fallbackName",
    disconnectFailedKey: "channels.wechatUser.disconnectFailedFallback",
  },
  feishu: {
    service: "feishu",
    defaultGrant: "app",
    renderPresenting: FeishuPresenting,
    conversationSettings: true,
  },
  email: {
    service: "email",
    defaultGrant: "inbox",
  },
  agents: {
    service: "agents",
    defaultGrant: "cloud",
  },
};

// ── ChannelConnectCard ──────────────────────────────────────────────────────

export interface ChannelConnectCardProps {
  config: ChannelConnectConfig;
  slot: ConnectionSlot;
  role: "primary" | "secondary";
  onRefresh: () => void | Promise<void>;
  /** Connect a new account of the service rather than the slot's own. */
  another?: boolean;
  /** Cancel the setup when the card goes away. Defaults to `another`. */
  cancelOnLeave?: boolean;
  /** Fired after a setup connects, in place of the refresh, with the
   *  connection it connected when core reports it. */
  onConnected?: (connectionId: string | null) => void;
}

/**
 * The single channel connect card. When connected it shows the folded identity +
 * Disconnect (and, per config, a "linked as guardian" note); when not, it runs
 * the setup through the standard renderers (plus any per-service custom
 * renderer). A channel that reads connected was guardian-linked during the
 * terminal conferral, so there is no separate verify-status polling.
 */
export function ChannelConnectCard({
  config,
  slot,
  role,
  onRefresh,
  another = false,
  cancelOnLeave,
  onConnected,
}: ChannelConnectCardProps) {
  const { t } = useTranslation("settings");
  const connected = slot.state !== "unauthorized";
  // A degraded credential is renewed in place: disconnecting would remove the
  // account, and an account that connects again starts with no history.
  const degraded = slot.state === "degraded";

  const [disconnecting, setDisconnecting] = useState(false);
  // Disconnecting an account removes it, so the guardian confirms the cost first.
  const [confirming, setConfirming] = useState(false);
  const confirmsDisconnect = LINKABLE_SERVICES.has(config.service);
  const [error, setError] = useState<string | null>(null);

  // The setup addresses the connection by id, or by the bare service name when
  // the guardian has never connected or is adding another account (the
  // terminal conferral mints the row).
  const setup = useSetup({
    idOrService: (another ? null : slot.connectionId) ?? config.service,
    grant: slot.grant ?? config.defaultGrant,
    another,
    cancelOnLeave,
    activeCid: slot.activeSetupCid,
    // A caller that opens the account it connected refetches as it does, so
    // the refresh does not first drop a card whose route the connect moved.
    onDone: (connectionId) => {
      if (onConnected) onConnected(connectionId);
      else void onRefresh();
    },
  });

  // A finished Reconnect is dropped once the account reads healthy, so a later
  // fault offers Reconnect again instead of the old finished view.
  const setupStatus = setup.state?.status;
  const { reset } = setup;
  useEffect(() => {
    if (slot.state === "authorized" && setupStatus === "done") reset();
  }, [slot.state, setupStatus, reset]);

  async function handleDisconnect() {
    if (!slot.connectionId || !slot.grant) return;
    setDisconnecting(true);
    setError(null);
    const result = await revokeConnectionGrant(slot.connectionId, slot.grant);
    if (!result.ok) {
      setError(
        result.error || t(config.disconnectFailedKey ?? "channels.disconnectFailedFallback"),
      );
    } else {
      // Drop any stale terminal setup state so the unconnected card offers a
      // fresh Connect instead of the previous "done" view (no page reload).
      setup.reset();
      await onRefresh();
    }
    setDisconnecting(false);
  }

  const disconnectButton = connected ? (
    <Button
      variant="destructive"
      size="sm"
      onClick={() => (confirmsDisconnect ? setConfirming(true) : void handleDisconnect())}
      disabled={disconnecting}
    >
      {disconnecting ? t("common.disconnecting") : t("common.disconnect")}
    </Button>
  ) : undefined;
  const disconnectAction =
    degraded && !setup.state ? (
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setup.start(true)} disabled={setup.busy}>
          {setup.busy ? t("common.connecting") : t("channels.reconnect")}
        </Button>
        {disconnectButton}
      </div>
    ) : (
      disconnectButton
    );

  const configureAction =
    connected && slot.connectionId && config.conversationSettings ? (
      <Button variant="outline" size="sm" asChild>
        <Link to={`/settings/channels?connectionId=${encodeURIComponent(slot.connectionId)}`}>
          {t("channels.conversationSettings.configure")}
        </Link>
      </Button>
    ) : null;

  const identityTitle = connected
    ? (slot.identity ?? (config.identityFallbackKey ? t(config.identityFallbackKey) : null))
    : null;

  return (
    <ConnectionSlotCard
      service={config.copyService ?? config.service}
      slot={slot}
      state={connected ? "connected" : "unconnected"}
      role={role}
      icon={config.icon ?? <ConnectionBrandBadge connection={config.service} />}
      identityTitle={identityTitle}
      action={
        configureAction ? (
          <div className="flex items-center gap-2">
            {configureAction}
            {disconnectAction}
          </div>
        ) : (
          disconnectAction
        )
      }
    >
      {error && <p className="text-aux text-destructive-fg">{error}</p>}
      <RomeConfirmDialog
        open={confirming}
        destructive
        title={
          identityTitle
            ? t("channels.disconnectConfirmTitle", { name: identityTitle })
            : t("channels.disconnectConfirmTitleUnnamed")
        }
        description={t("channels.disconnectConfirmBody")}
        confirmLabel={t("common.disconnect")}
        confirmDisabled={disconnecting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void handleDisconnect();
        }}
      />

      {degraded && setup.error && !setup.state ? (
        <p className="text-aux text-destructive-fg">{setup.error}</p>
      ) : null}
      {connected && !(degraded && setup.state) ? (
        config.guardianLinkedKey ? (
          <div>
            <p className="text-aux text-success-fg">{t(config.guardianLinkedKey)}</p>
          </div>
        ) : null
      ) : setup.state ? (
        <SetupRenderer
          state={setup.state}
          busy={setup.busy}
          error={setup.error}
          onSubmit={setup.submit}
          onCancel={setup.cancel}
          onRetry={() => setup.start(true)}
          renderPresenting={config.renderPresenting}
        />
      ) : (
        <div className="space-y-3">
          {setup.error && <p className="text-aux text-destructive-fg">{setup.error}</p>}
          <Button
            variant={role === "secondary" ? "outline" : "default"}
            size={role === "secondary" ? "sm" : "md"}
            onClick={() => setup.start()}
            disabled={setup.busy}
          >
            {setup.busy ? t("common.connecting") : t("common.connect")}
          </Button>
        </div>
      )}
    </ConnectionSlotCard>
  );
}

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { ConnectionSlotCard } from "@/components/connection-slot-card";
import {
  SetupRenderer,
  StandardSetupRenderer,
  type SetupComponentRegistry,
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
// varies are its grant name, a couple of copy keys, and (for two services) a
// genuinely custom piece: Discord's post-connect routing table and Feishu's
// QR-image setup renderer. Those are the "registered custom components"; the
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

const FEISHU_SETUP_REGISTRY: SetupComponentRegistry = {
  "feishu:presenting": FeishuPresenting,
};

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
  /** Extra content rendered under the connected view — Discord's routing table. */
  connectedExtra?: ReactNode;
  /** Custom setup renderers for this service — Feishu's QR image. */
  registry?: SetupComponentRegistry;
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

/** The telegram personal-account glyph — a muted user circle instead of the
 *  Telegram brand badge (the bot slot owns the brand mark on the same card). */
function TelegramUserIcon() {
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
    icon: <TelegramUserIcon />,
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
  feishu: {
    service: "feishu",
    defaultGrant: "app",
    registry: FEISHU_SETUP_REGISTRY,
    conversationSettings: true,
  },
  email: {
    service: "email",
    defaultGrant: "inbox",
  },
};

// ── ChannelConnectCard ──────────────────────────────────────────────────────

export interface ChannelConnectCardProps {
  config: ChannelConnectConfig;
  slot: ConnectionSlot;
  role: "primary" | "secondary";
  onRefresh: () => void | Promise<void>;
}

/**
 * The single channel connect card. When connected it shows the folded identity +
 * Disconnect (and, per config, a "linked as guardian" note and/or a custom
 * connected-state panel like Discord's routing table); when not, it runs the
 * setup through the standard renderers (plus any per-service custom
 * renderer). A channel that reads connected was guardian-linked during the
 * terminal conferral, so there is no separate verify-status polling.
 */
export function ChannelConnectCard({ config, slot, role, onRefresh }: ChannelConnectCardProps) {
  const { t } = useTranslation("settings");
  const connected = slot.state !== "unauthorized";

  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The setup addresses the connection by id, or by the bare service name when
  // the guardian has never connected (the terminal conferral mints the row).
  const setup = useSetup({
    idOrService: slot.connectionId ?? config.service,
    grant: slot.grant ?? config.defaultGrant,
    activeCid: slot.activeSetupCid,
    onDone: () => {
      void onRefresh();
    },
  });

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

  const disconnectAction = connected ? (
    <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
      {disconnecting ? t("common.disconnecting") : t("common.disconnect")}
    </Button>
  ) : undefined;

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

      {connected ? (
        config.guardianLinkedKey || config.connectedExtra ? (
          <div>
            {config.guardianLinkedKey && (
              <p className="text-aux text-success-fg">{t(config.guardianLinkedKey)}</p>
            )}
            {config.connectedExtra}
          </div>
        ) : null
      ) : setup.state ? (
        <SetupRenderer
          service={config.service}
          state={setup.state}
          busy={setup.busy}
          error={setup.error}
          onSubmit={setup.submit}
          onCancel={setup.cancel}
          onRetry={() => setup.start(true)}
          registry={config.registry}
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

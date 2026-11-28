import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, User } from "lucide-react";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { ConnectionSlotCard, SlotCeremonyFrame } from "@/components/connection-slot-card";
import { warnIfAccessKept } from "@/components/connections/access-kept-warning";
import {
  SetupRenderer,
  StandardSetupRenderer,
  type SetupRenderProps,
} from "@/components/setup/setup-renderer";
import { useSetup } from "@/components/setup/use-setup";
import type { ConnectionSlot } from "@/lib/connection-cards";
import { revokeConnectionGrant } from "@/lib/connections-api";
import {
  DiscordServersSection,
  openDiscordPage,
  reserveDiscordTab,
} from "@/components/connections/discord-servers-section";

// Every Talk channel connects through the setup: the card
// is a thin frame around `useSetup` (drives `/api/connections/:id/grants/:name/
// setup` + `/api/setups/:cid/input`) and the standard `SetupRenderer`. What used
// to be seven near-identical per-service cards (telegram bot / telegram user /
// whatsapp / discord / feishu / email) is a single component driven by
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
  const { t } = useTranslation("settings");
  const { state } = props;
  if (state.status !== "presenting") return <StandardSetupRenderer {...props} />;
  const qr = state.view.links?.find((link) => link.url.startsWith("data:image/"));
  if (!qr) return <StandardSetupRenderer {...props} />;
  const view = { ...state.view, links: state.view.links?.filter((link) => link !== qr) };
  const qrAlt =
    state.view.id && qr.id
      ? t(`connections.setup.views.${state.view.id}.links.${qr.id}`, { defaultValue: qr.label })
      : qr.label;
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <img
        src={qr.url}
        alt={qrAlt}
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
  /** Grant to address before a connection row exists; the terminal grant
   *  mints the row, so this is the fallback when `slot.grant` is null. */
  defaultGrant: string;
  /** ConnectionSlotCard copy namespace (`connections.cards.<copyService>`) when
   *  it differs from the setup service — the telegram personal account presents
   *  under the telegram card. Defaults to `service`. */
  copyService?: string;
  /** Custom renderer for the `presenting` setup state — Feishu's QR image. */
  renderPresenting?: ComponentType<SetupRenderProps>;
  /** Header icon override; defaults to the service brand badge. */
  icon?: ReactNode;
  /** Copy key for the connected title when the slot has no folded identity. */
  identityFallbackKey?: string;
  /** Disconnect-failed fallback copy key; defaults to
   *  `channels.disconnectFailedFallback`. */
  disconnectFailedKey?: string;
  /** What the card shows under a working connection, such as the servers
   *  Rome's Discord bot was added to. */
  connectedSection?: ComponentType<{ onDisconnect: () => void; disconnecting: boolean }>;
  /** The one line an unconnected card shows in place of its bullets, for a
   *  card with a `connectedSection`, which shows no bullets either. */
  blurbKey?: string;
  /** Copy key of the connect button; defaults to `common.connect`. */
  connectLabelKey?: string;
  /** A page to open once connecting is done, such as Discord's page that adds
   *  Rome's bot to a server: one click connects and opens it. `reserve` runs
   *  in the click (a tab, or null where the shell opens pages itself), `open`
   *  after the connect; `failedKey` words an `open` that failed. */
  pageAfterConnect?: {
    reserve: () => Window | null;
    open: (tab: Window | null) => Promise<void>;
    failedKey: string;
  };
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
  },
  feishu: {
    service: "feishu",
    defaultGrant: "app",
    renderPresenting: FeishuPresenting,
  },
  email: {
    service: "email",
    defaultGrant: "inbox",
  },
  slack_app: {
    service: "slack_app",
    defaultGrant: "bot",
  },
  discord_app: {
    service: "discord_app",
    defaultGrant: "bot",
    connectedSection: DiscordServersSection,
    blurbKey: "channels.discordApp.blurb",
    connectLabelKey: "channels.discordApp.link",
    pageAfterConnect: {
      reserve: reserveDiscordTab,
      open: openDiscordPage,
      failedKey: "channels.discordApp.addFailed",
    },
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
 * terminal grant, so there is no separate verify-status polling.
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
  const connected = slot.state !== null;
  // A broken connection is fixed in place: disconnecting would remove the
  // account, and an account that connects again starts with no history.
  const broken = slot.state === "broken";

  const [disconnecting, setDisconnecting] = useState(false);
  // Disconnecting an account removes it, so the guardian confirms the cost first.
  const [confirming, setConfirming] = useState(false);
  const confirmsDisconnect = Boolean(slot.link);
  const [error, setError] = useState<string | null>(null);

  // A connect started from a click that also opens a page: whether the page is
  // wanted, and the tab reserved for it in the click (null where the shell
  // opens pages itself).
  const page = useRef<{ tab: Window | null } | null>(null);
  const begin = (again = false) => {
    page.current = config.pageAfterConnect ? { tab: config.pageAfterConnect.reserve() } : null;
    setup.start(again);
  };

  // The setup addresses the connection by id, or by the bare service name when
  // the guardian has never connected or is adding another account (the
  // terminal grant mints the row).
  const setup = useSetup({
    idOrKind: (another ? null : slot.connectionId) ?? config.service,
    grant: slot.grant ?? config.defaultGrant,
    another,
    cancelOnLeave,
    activeCid: slot.activeSetupCid,
    // A caller that opens the account it connected refetches as it does, so
    // the refresh does not first drop a card whose route the connect moved.
    onDone: (connectionId) => {
      const wanted = page.current;
      page.current = null;
      if (wanted && config.pageAfterConnect) {
        const { failedKey } = config.pageAfterConnect;
        config.pageAfterConnect
          .open(wanted.tab)
          .catch((cause: unknown) =>
            setError((cause instanceof Error && cause.message) || t(failedKey)),
          );
      }
      if (onConnected) onConnected(connectionId);
      else void onRefresh();
    },
  });

  // A connect that failed or was cancelled opens no page.
  const setupEnded = setup.state?.status === "failed" || setup.state?.status === "cancelled";
  useEffect(() => {
    if ((setup.error || setupEnded) && page.current) {
      page.current.tab?.close();
      page.current = null;
    }
  }, [setup.error, setupEnded]);

  // A finished Reconnect is dropped once the account reads healthy, so a later
  // fault offers Reconnect again instead of the old finished view.
  const setupStatus = setup.state?.status;
  const { reset } = setup;
  useEffect(() => {
    if (slot.state === "working" && setupStatus === "done") reset();
  }, [slot.state, setupStatus, reset]);

  // A cancelled setup returns the card straight to Connect / Reconnect, matching
  // OAuthConnectionSection instead of parking on a dead "Cancelled + Try again" view.
  const activeSetup = setup.state && setup.state.status !== "cancelled" ? setup.state : null;

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
      // Warned first, so a refresh that fails still shows it.
      warnIfAccessKept(result);
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
    broken && !activeSetup ? (
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setup.start(true)} disabled={setup.busy}>
          {setup.busy ? t("common.connecting") : t("channels.reconnect")}
        </Button>
        {disconnectButton}
      </div>
    ) : (
      disconnectButton
    );

  const identityTitle = connected
    ? (slot.identity ?? (config.identityFallbackKey ? t(config.identityFallbackKey) : null))
    : null;

  // A card with its own connected view draws the account and its action itself.
  const ownView = Boolean(config.connectedSection) && connected && !broken;

  const setupRenderer = activeSetup ? (
    <SetupRenderer
      state={activeSetup}
      busy={setup.busy}
      error={setup.error}
      onSubmit={setup.submit}
      onCancel={setup.cancel}
      onRetry={() => begin(true)}
      renderPresenting={config.renderPresenting}
    />
  ) : null;

  return (
    <ConnectionSlotCard
      service={config.copyService ?? config.service}
      slot={slot}
      state={connected ? "connected" : "unconnected"}
      role={role}
      icon={config.icon ?? <ConnectionBrandBadge connection={config.service} />}
      identityTitle={ownView ? null : identityTitle}
      action={ownView ? undefined : disconnectAction}
      plain={Boolean(config.connectedSection)}
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

      {broken && setup.error && !activeSetup ? (
        <p className="text-aux text-destructive-fg">{setup.error}</p>
      ) : null}
      {connected && !(broken && activeSetup) ? (
        config.connectedSection && !broken ? (
          <config.connectedSection
            onDisconnect={() =>
              confirmsDisconnect ? setConfirming(true) : void handleDisconnect()
            }
            disconnecting={disconnecting}
          />
        ) : null
      ) : setupRenderer ? (
        <SlotCeremonyFrame>{setupRenderer}</SlotCeremonyFrame>
      ) : (
        <div
          className={
            config.blurbKey
              ? "flex flex-wrap items-center gap-4 rounded-12 border border-border bg-surface p-4"
              : "space-y-3"
          }
        >
          {config.blurbKey && (
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-ui font-medium text-foreground">{t(config.blurbKey)}</p>
              <p className="text-aux text-muted-foreground">{t(`${config.blurbKey}Detail`)}</p>
            </div>
          )}
          {setup.error && <p className="text-aux text-destructive-fg">{setup.error}</p>}
          <Button
            variant={role === "secondary" ? "outline" : "default"}
            size={role === "secondary" ? "sm" : "md"}
            onClick={() => begin()}
            disabled={setup.busy}
          >
            {setup.busy ? t("common.connecting") : t(config.connectLabelKey ?? "common.connect")}
            {config.pageAfterConnect && !setup.busy && (
              <ArrowUpRight data-icon="inline-end" aria-hidden />
            )}
          </Button>
        </div>
      )}
    </ConnectionSlotCard>
  );
}

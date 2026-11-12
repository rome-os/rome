import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { StatusIndicator } from "@/lib/connection-status";
import { DetailPane } from "@/components/connections/detail-pane";
import { AvailableToAddLabel, SoleSlotScope } from "@/components/connection-slot-card";
import { OAuthConnectionSection } from "@/components/connections/oauth-connection-section";
import { ComposioConnectionSection } from "@/components/connections/composio-connection-section";
import { AccountControls } from "@/components/connections/account-controls";
import type { ConnectionCard, ConnectionSlot } from "@/lib/connection-cards";
import type { ComposioCliStatus } from "@/lib/provider-types";
import { CHANNEL_CONFIGS, ChannelConnectCard } from "@/components/channels/channel-connect-card";

/**
 * Shared Connection detail body — a list of slot cards. Each slot renders as a
 * {@link ConnectionSlotCard}: a header (icon / connected identity or slot title /
 * subtitle / primary action), a plain-language enablement bullet section (✓ when
 * connected, + when not), an optional privacy note, and the service-specific
 * ceremony inline. Rendered both by the standalone
 * `/settings/connections/:serviceId` page and by the in-list
 * {@link ConnectionDetailPane}, so the two surfaces never drift.
 *
 * The frame is service-agnostic; card-level facts come from `/api/connections`
 * (via the `ConnectionCard` presentation adapter) and each ceremony self-serves
 * its transient state from its own kept ceremony routes. {@link SlotEntry} is
 * the only place that dispatches on the service. Adding or restyling a service
 * touches its own ceremony component and its `connections.cards.<service>`
 * copy, never this file.
 */
export function ConnectionDetailBody({
  card,
  composio,
  onRefresh,
  onFlash,
  onOpenAccount,
}: {
  card: ConnectionCard;
  composio: ComposioCliStatus | null;
  /** Re-fetch `/api/connections` (and the Composio status where shown). */
  onRefresh: () => void;
  onFlash: (message: string) => void;
  /** Open another account's card by its connection id, after "Add another
   *  account" connected it. Without it, the add button is hidden. */
  onOpenAccount?: (connectionId: string) => void | Promise<void>;
}) {
  // A slot is "secondary" (an add-on shown under "Available to add") when it
  // follows the primary slot. Telegram is the only multi-slot connection in
  // v1: its personal-account slot is always secondary to the bot.

  const body = (
    <div className="space-y-6">
      {card.slots.map((slot, index) => {
        const isSecondary = index > 0;
        const showAvailableToAdd = isSecondary && slot.state === null;
        const role = isSecondary ? "secondary" : "primary";
        return (
          <div key={slot.key} className="space-y-2">
            {showAvailableToAdd && <AvailableToAddLabel />}
            <SlotEntry
              card={card}
              slot={slot}
              role={role}
              composio={composio}
              onRefresh={onRefresh}
              onFlash={onFlash}
              onOpenAccount={onOpenAccount}
            />
          </div>
        );
      })}
      <AccountControls card={card} onRefresh={onRefresh} onOpenAccount={onOpenAccount} />
    </div>
  );

  // A single-slot connection renders its slot bare — the dialog is the card.
  return card.slots.length === 1 ? <SoleSlotScope>{body}</SoleSlotScope> : body;
}

/**
 * Render one slot. Every service self-composes its own {@link ConnectionSlotCard}
 * (owning the header icon, connected identity, and Disconnect/Reconnect action)
 * and mounts its ceremony as the card's children — so the connected identity +
 * primary action sit in the header row per the mockup. This is the only place
 * that dispatches on the service; adding or restyling a service touches its own
 * ceremony component and its `connections.cards.<service>` copy.
 */
function SlotEntry({
  card,
  slot,
  role,
  composio,
  onRefresh,
  onFlash,
  onOpenAccount,
}: {
  card: ConnectionCard;
  slot: ConnectionSlot;
  role: "primary" | "secondary";
  composio: ComposioCliStatus | null;
  onRefresh: () => void;
  onFlash: (message: string) => void;
  onOpenAccount?: (connectionId: string) => void | Promise<void>;
}) {
  // Talk channels all render through the single generic ChannelConnectCard,
  // driven by a per-service config. Telegram and WeChat each carry two slots —
  // the bot (primary) and the guardian's own account (the `session` slot, keyed
  // to that brand's personal-account config).
  const channelConfig =
    slot.key === "session" && CHANNEL_CONFIGS[`${card.service}_user`]
      ? CHANNEL_CONFIGS[`${card.service}_user`]
      : CHANNEL_CONFIGS[card.service];
  if (channelConfig) {
    // Open the account once it connects: an account that starts fresh can get
    // a channel, and so a route, other than the card it connected from.
    const opened = onOpenAccount
      ? (connectionId: string | null) => {
          if (!connectionId) return onRefresh();
          void Promise.resolve(onOpenAccount(connectionId)).catch(() => onRefresh());
        }
      : undefined;
    return (
      <ChannelConnectCard
        config={channelConfig}
        slot={slot}
        role={role}
        onRefresh={onRefresh}
        onConnected={opened}
      />
    );
  }

  if (card.kind === "oauth") {
    return (
      <OAuthConnectionSection
        card={card}
        slot={slot}
        role={role}
        onRefresh={onRefresh}
        onFlash={onFlash}
      />
    );
  }

  // The only remaining kind is composio (channel services + oauth are all
  // handled above).
  return (
    <ComposioConnectionSection
      card={card}
      slot={slot}
      role={role}
      composio={composio}
      onRefresh={onRefresh}
      onFlash={onFlash}
    />
  );
}

/** A card's detail as a pane in place of the Settings › Connections grids. */
export function ConnectionDetailPane({
  card,
  backLabel,
  composio,
  onClose,
  onRefresh,
  onFlash,
  onOpenAccount,
}: {
  card: ConnectionCard;
  backLabel: string;
  composio: ComposioCliStatus | null;
  onClose: () => void;
  onRefresh: () => void;
  onFlash: (message: string) => void;
  onOpenAccount?: (connectionId: string) => void | Promise<void>;
}) {
  return (
    <DetailPane
      label={card.label}
      backLabel={backLabel}
      onClose={onClose}
      mark={<ConnectionBrandBadge connection={card.service} />}
      status={<StatusIndicator card={card} />}
    >
      <ConnectionDetailBody
        key={card.route}
        card={card}
        composio={composio}
        onRefresh={onRefresh}
        onFlash={onFlash}
        onOpenAccount={onOpenAccount}
      />
    </DetailPane>
  );
}

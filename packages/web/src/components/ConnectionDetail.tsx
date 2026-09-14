import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { StatusIndicator } from "@/lib/connection-status";
import { AvailableToAddLabel, SoleSlotScope } from "@/components/connection-slot-card";
import { OAuthConnectionSection } from "@/components/connections/oauth-connection-section";
import { ComposioConnectionSection } from "@/components/connections/composio-connection-section";
import { WebchatConnectionCard } from "@/components/connections/webchat-connection-card";
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
 * `ConnectionDetailDialog`, so the two surfaces never drift.
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
}: {
  card: ConnectionCard;
  composio: ComposioCliStatus | null;
  /** Re-fetch `/api/connections` (and the Composio status where shown). */
  onRefresh: () => void;
  onFlash: (message: string) => void;
}) {
  // Always-on (webchat) has its own card — connected, ✓ bullets, no ceremony.
  if (card.alwaysOn) {
    return (
      <SoleSlotScope>
        <div className="space-y-4">
          <WebchatConnectionCard card={card} />
        </div>
      </SoleSlotScope>
    );
  }

  // A slot is "secondary" (an add-on shown under "Available to add") when it
  // follows the primary slot. Telegram is the only multi-slot connection in
  // v1: its personal-account slot is always secondary to the bot.

  const body = (
    <div className="space-y-6">
      {card.slots.map((slot, index) => {
        const isSecondary = index > 0;
        const showAvailableToAdd = isSecondary && slot.state === "unauthorized";
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
            />
          </div>
        );
      })}
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
}: {
  card: ConnectionCard;
  slot: ConnectionSlot;
  role: "primary" | "secondary";
  composio: ComposioCliStatus | null;
  onRefresh: () => void;
  onFlash: (message: string) => void;
}) {
  // Talk channels all render through the single generic ChannelConnectCard,
  // driven by a per-service config. The telegram card carries two slots — the
  // bot (primary) and the personal account (its `session` slot, keyed to the
  // `telegram_user` config).
  const channelConfig =
    card.service === "telegram" && slot.key === "session"
      ? CHANNEL_CONFIGS.telegram_user
      : CHANNEL_CONFIGS[card.service];
  if (channelConfig) {
    return (
      <ChannelConnectCard config={channelConfig} slot={slot} role={role} onRefresh={onRefresh} />
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
  // handled above; webchat's alwaysOn card is rendered before SlotEntry).
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

/**
 * In-list Connection detail dialog. Clicking a row in `ConnectionsSection`
 * opens this instead of navigating — the slot cards live in a modal over the
 * list. Header carries the brand badge, name, and dot+text status; the body is
 * the shared `ConnectionDetailBody`.
 */
export function ConnectionDetailDialog({
  card,
  composio,
  onClose,
  onRefresh,
  onFlash,
}: {
  card: ConnectionCard | null;
  composio: ComposioCliStatus | null;
  onClose: () => void;
  onRefresh: () => void;
  onFlash: (message: string) => void;
}) {
  return (
    <Dialog open={card !== null} onClose={onClose} size="lg">
      {card && (
        <>
          <ConnectionDetailHeader card={card} onClose={onClose} />
          <DialogBody>
            <ConnectionDetailBody
              card={card}
              composio={composio}
              onRefresh={onRefresh}
              onFlash={onFlash}
            />
          </DialogBody>
        </>
      )}
    </Dialog>
  );
}

export function ConnectionDetailHeader({
  card,
  onClose,
}: {
  card: ConnectionCard;
  onClose: () => void;
}) {
  return (
    <DialogHeader onClose={onClose}>
      <div className="flex items-center gap-3">
        <ConnectionBrandBadge connection={card.service} />
        <div className="min-w-0 flex-1">
          <DialogTitle className="text-body">{card.label}</DialogTitle>
          <StatusIndicator card={card} className="mt-1" />
        </div>
      </div>
    </DialogHeader>
  );
}

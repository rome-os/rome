import { useTranslation } from "react-i18next";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { ConnectionSlotCard } from "@/components/connection-slot-card";
import type { ConnectionCard } from "@/lib/connection-cards";

/**
 * Webchat is always-on and boot-wired — there is nothing to connect and no way
 * to disconnect. It renders as a permanently-connected slot card (solid border,
 * ✓ bullets, no Disconnect action, no ceremony) so it reads the same as every
 * other connection, with a single "Always on" confirmation line in place of a
 * ceremony. It is never a secondary slot, so no "Available to add" label applies.
 */
export function WebchatConnectionCard({ card }: { card: ConnectionCard }) {
  const { t } = useTranslation("settings");
  const slot = card.slots[0];
  return (
    <ConnectionSlotCard
      service={card.service}
      slot={slot}
      state="connected"
      role="primary"
      icon={<ConnectionBrandBadge connection="webchat" />}
    >
      <p className="text-ui text-muted-foreground">{t("connections.cards.webchat.bot.alwaysOn")}</p>
    </ConnectionSlotCard>
  );
}

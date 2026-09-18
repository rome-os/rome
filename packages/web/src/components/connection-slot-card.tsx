import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { slotCardCopy, slotHeadingKey } from "@/lib/connection-capability-copy";
import type { ConnectionSlot } from "@/lib/connection-cards";

/**
 * The slot-card frame — one card per credential slot in a Connection dialog.
 *
 * Anatomy (from the redesign mockup):
 *   ┌─ header row: [icon] [title / subtitle] [primary action] ─────────────┐
 *   │  ── enablement section (plain text): heading + bulleted list ────────  │
 *   │  ── optional privacy lock box ──────────────────────────────────────  │
 *   │  ── ceremony (children): the service-specific connect controls ──────  │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Connected slots get a solid border and their bullets under "This connection
 * lets your agent". Unconnected slots get a dashed border and bullets under
 * either "This connection will let your agent" (a primary/first slot) or
 * "Adding it lets your agent also" (a secondary add-on slot); state is carried
 * by the heading wording, the list markers are plain. The "Available to add" label
 * above secondary unconnected slots is rendered by the caller (it lives outside
 * the card), driven by {@link availableToAddLabel}.
 *
 * The frame is service-agnostic: it reads all copy through `slotCardCopy` and
 * takes the header icon, an optional identity title override, the primary action
 * node, and the ceremony as props/children. Per-service agents only supply those
 * pieces — they never restyle the frame.
 *
 * When a connection has exactly ONE slot, nesting a full card inside the dialog
 * reads as chrome-on-chrome: the dialog header already carries the brand badge
 * and the service name, so the inner card's border, icon, and (while
 * unconnected) title just repeat it. {@link SoleSlotScope} marks that case: the
 * body wraps its single slot in the scope and the card renders "bare" — no
 * border box, no icon, and no unconnected title or setup subtitle (the ceremony
 * below carries the how-to). Once connected the header row returns (sans icon)
 * because it now carries real information: the live identity, any identity
 * detail, and the Disconnect action. The scope lives here (not a prop) so
 * per-service cards
 * stay frame-agnostic — the decision belongs to the body that knows the slot
 * count, and multi-slot connections (Telegram) keep the full card frame.
 */

const SoleSlotContext = createContext(false);

/** Wrap a connection body that renders exactly one slot: the slot card inside
    drops its card chrome (border, icon, unconnected title). */
export function SoleSlotScope({ children }: { children: ReactNode }) {
  return <SoleSlotContext.Provider value={true}>{children}</SoleSlotContext.Provider>;
}

/** Whether a slot's credential is held (drives ✓ vs + and the border style). */
export type SlotCardState = "connected" | "unconnected";

export interface ConnectionSlotCardProps {
  /** The service name — the copy namespace (`connections.cards.<service>`). */
  service: string;
  slot: ConnectionSlot;
  state: SlotCardState;
  /**
   * "primary" for the first/only slot, "secondary" for an add-on slot shown
   * once another slot is already present. Only affects the unconnected heading.
   */
  role: "primary" | "secondary";
  /** The header icon (brand badge, avatar, or a muted glyph). */
  icon: ReactNode;
  /**
   * The connected identity to show as the title (e.g. `@botUsername`), used for
   * slots whose card title IS the identity. When null, the card falls back to
   * the slot's copy title.
   */
  identityTitle?: string | null;
  /**
   * The connected-state line under the title (e.g. the phone number or account
   * email). The copy subtitle is setup guidance ("Sign in with your phone
   * number"), so it only renders while unconnected; once connected the card
   * shows this instead when supplied.
   */
  connectedSubtitle?: ReactNode;
  /** The right-aligned primary action (Disconnect / Reconnect), if any. */
  action?: ReactNode;
  /** The service-specific connect ceremony (controls + inline instructions). */
  children?: ReactNode;
}

export function ConnectionSlotCard({
  service,
  slot,
  state,
  role,
  icon,
  identityTitle,
  connectedSubtitle,
  action,
  children,
}: ConnectionSlotCardProps) {
  const { t } = useTranslation("settings");
  const bare = useContext(SoleSlotContext);
  const connected = state === "connected";
  const copy = slotCardCopy(service, slot, identityTitle != null);

  // The title is the connected identity when the slot supplies one and its copy
  // yields the title to it; otherwise the copy title. A bare card drops the
  // unconnected title — the dialog header already names the service.
  const copyTitle = copy.title ? t(copy.title.key, copy.title.params) : null;
  const title = identityTitle ?? (bare && !connected ? null : copyTitle);

  // The setup subtitle ("Sign in with GitHub", "Add a bot from @BotFather") is
  // the slot's descriptor in a framed multi-slot card. A bare card drops it too:
  // the ceremony instructions right below say the same thing in more detail.
  const subtitle = connected
    ? connectedSubtitle && <p className="text-ui text-muted-foreground">{connectedSubtitle}</p>
    : copy.subtitle &&
      !bare && (
        <p className="text-ui text-muted-foreground">
          {t(copy.subtitle.key, copy.subtitle.params)}
        </p>
      );

  const headingRole = connected ? "connected" : role;

  return (
    <section
      className={cn(
        "space-y-4",
        !bare && "rounded-12 border bg-surface p-4",
        !bare && (connected ? "border-border" : "border-dashed border-border"),
      )}
    >
      {(title || subtitle || action) && (
        <div className="flex items-start gap-3">
          {!bare && <div className="mt-1 shrink-0">{icon}</div>}
          <div className="min-w-0 flex-1 space-y-1">
            {title && <p className="truncate text-ui text-foreground">{title}</p>}
            {subtitle}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}

      {copy.bullets.length > 0 && (
        <div className="space-y-2 text-ui text-foreground">
          <p>{t(slotHeadingKey(headingRole))}</p>
          <ul className="list-disc space-y-2 pl-5">
            {copy.bullets.map((bullet) => (
              <li key={bullet.key}>{t(bullet.key, bullet.params)}</li>
            ))}
          </ul>
        </div>
      )}

      {copy.privacyNote && (
        <div className="flex items-start gap-2 rounded-8 bg-info-bg p-3 text-ui text-info-fg">
          <Lock className="mt-1 size-4 shrink-0" aria-hidden />
          <span>{t(copy.privacyNote.key, copy.privacyNote.params)}</span>
        </div>
      )}

      {children}
    </section>
  );
}

/** The muted "Available to add" section label rendered above secondary slots. */
export function AvailableToAddLabel() {
  const { t } = useTranslation("settings");
  return (
    <p className="px-1 text-aux text-muted-foreground">
      {t("connections.headings.availableToAdd")}
    </p>
  );
}

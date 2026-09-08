/**
 * Read-only copy for the Connection detail page's slot cards.
 *
 * Each slot renders as a card (see `connection-slot-card.tsx`) whose plain-language
 * enablement bullets, title, subtitle, and (where warranted) privacy note are all
 * hand-written per service — the internal Talk/Act/Watch taxonomy never surfaces.
 * This module is a pure key map from `(service, slot key)` to the settings-
 * namespace i18n keys the card renders; the consumer owns the `t()` call so every
 * locale reads the same way.
 *
 * Copy lives under `connections.cards.<service>.<slot>`:
 *   - `title` / `titleFallback` — the card's slot title. Services whose connected
 *     identity is not the title (Telegram/Discord bots show `@identity` as the
 *     title and fall back to `titleFallback` before connecting) carry both.
 *   - `subtitle` — a short "how you add it" line under the title.
 *   - `bullets.*` — the enablement bullets, keyed by name. The ordered key list
 *     per slot lives in {@link BULLET_KEYS} here (i18n JSON has no arrays), so the
 *     card renders them in a stable order. Bullets may interpolate `{{identity}}`.
 *   - `bulletsFallback.*` — the bullet set to use before the identity is known
 *     (so an unconnected bot reads "Reply when people message your bot", not a
 *     dangling `{{identity}}`). Only services that interpolate identity carry it.
 *   - `privacyNote` — the lock-box reassurance line, only where warranted
 *     (personal-account sessions, OAuth token storage).
 *
 * Shared card headings ("This connection lets your agent" etc.) and the
 * "Available to add" label live under `connections.headings.*`.
 */

import type { ConnectionSlot } from "@/lib/connection-cards";

/**
 * A resolved copy line: the settings-namespace i18n key plus optional
 * interpolation params. The consumer renders it with `t(key, params)`.
 */
export interface CopyDescriptor {
  key: string;
  params?: Record<string, string>;
}

/** The resolved copy for one slot card. */
export interface SlotCardCopy {
  /** The card title key. Null when the connected identity is the title. */
  title: CopyDescriptor | null;
  /** The short "how to add it" subtitle. Null when there is none. */
  subtitle: CopyDescriptor | null;
  /** The plain-language enablement bullets, in render order. */
  bullets: CopyDescriptor[];
  /** The lock-box reassurance line, or null when none is warranted. */
  privacyNote: CopyDescriptor | null;
}

/**
 * The ordered bullet key names per `${connectionId}.${slotId}`. i18n JSON stores
 * bullets as a named object (no arrays), so the order is owned here. A slot with
 * no entry renders no bullets.
 */
const BULLET_KEYS: Record<string, string[]> = {
  "telegram.bot": ["reply", "start"],
  "telegram.session": ["send", "read", "notice"],
  "whatsapp.bot": ["reply", "start"],
  "wechat.bot": ["reply", "start"],
  "linkedin.bot": ["read", "recap"],
  "discord.bot": ["reply", "start"],
  "feishu.bot": ["reply", "start"],
  "email.bot": ["reply", "start"],
  "webchat.bot": ["chat"],
  "github.user": ["work", "watch"],
  "google.user": ["work"],
  "slack.user": ["work"],
  "composio.user": ["act"],
};

/**
 * Slots whose bullets interpolate the connected identity. Before the identity is
 * known these read from `bulletsFallback` (and the title from `titleFallback`)
 * instead, so an unconnected bot never shows a dangling `{{identity}}`.
 */
const IDENTITY_SLOTS = new Set(["telegram.bot", "discord.bot"]);

/**
 * Resolve the full copy for one slot card. `identityKnown` selects the
 * identity-interpolating vs. fallback copy for slots that carry both.
 */
export function slotCardCopy(
  service: string,
  slot: ConnectionSlot,
  identityKnown: boolean,
): SlotCardCopy {
  const slotKey = `${service}.${slot.key}`;
  const base = `connections.cards.${service}.${slot.key}`;
  const usesIdentity = IDENTITY_SLOTS.has(slotKey);
  const withIdentity = usesIdentity && identityKnown;

  // Identity-interpolating slots keep the connected identity as the title; only
  // their fallback (pre-connect) copy names the slot. Every other slot has a
  // static `title`.
  const title: CopyDescriptor | null = usesIdentity
    ? withIdentity
      ? null
      : { key: `${base}.titleFallback` }
    : { key: `${base}.title` };

  const subtitle: CopyDescriptor | null = SUBTITLE_SLOTS.has(slotKey)
    ? { key: `${base}.subtitle` }
    : null;

  // Identity slots read fallback bullets until the identity is known; every
  // other slot always reads its `bullets`.
  const bulletsBase = usesIdentity && !withIdentity ? `${base}.bulletsFallback` : `${base}.bullets`;
  const bullets: CopyDescriptor[] = (BULLET_KEYS[slotKey] ?? []).map((name) => ({
    key: `${bulletsBase}.${name}`,
    params: slot.identity ? { identity: slot.identity } : undefined,
  }));

  const privacyNote: CopyDescriptor | null = PRIVACY_SLOTS.has(slotKey)
    ? { key: `${base}.privacyNote` }
    : null;

  return { title, subtitle, bullets, privacyNote };
}

/**
 * Slots that carry a `subtitle` key. Only Telegram: a single-slot connection
 * renders its card bare (see `SoleSlotScope`), and a bare card drops the
 * subtitle, so a subtitle on any other service would never reach the screen.
 */
const SUBTITLE_SLOTS = new Set(["telegram.bot", "telegram.session"]);

/** Slots that carry a `privacyNote` lock box. */
const PRIVACY_SLOTS = new Set(["telegram.session", "github.user", "google.user", "slack.user"]);

/** The card heading for a slot given its connected/primary/secondary role. */
export function slotHeadingKey(role: "connected" | "primary" | "secondary"): string {
  return `connections.headings.${role}`;
}

// The share-location card: core's own widget that asks the guardian for their
// position once, for one turn. Nothing it carries is stored beyond the chat's
// own messages, and it is not a connection. Domain: docs/domains/chats.md#widget.

import type { WidgetUi } from "@rome-os/app-runtime";
import {
  LOCATION_CARD_ID,
  type LocationAnswer,
  locationCardUi,
} from "@rome/api-types/location-card";
import { GUARDIAN_OWNER, ownerOf } from "./owner.js";
import { type ChatPrivacyRow, privateOwnerOf } from "./privacy.js";

/** Above this accuracy radius, in meters, the agent names only the area. */
export const COARSE_ACCURACY_METERS = 3_000;

/** The longest reason the card shows. */
const MAX_REASON_LENGTH = 200;

/**
 * Whether a dashboard chat is read by the guardian alone, so a position said
 * in it reaches nobody else. A chat private to the guardian (their Concierge's
 * chats, its task chats and their children) is. Any other chat opens for every
 * dashboard user, so it is only while nobody but the guardian may open the
 * dashboard.
 */
export function chatReadByGuardianAlone(
  chat: ChatPrivacyRow | null,
  visitorsAllowed: boolean,
): boolean {
  if (!chat) return false;
  const privateTo = privateOwnerOf(chat);
  if (privateTo !== null) return privateTo === GUARDIAN_OWNER;
  return ownerOf(chat) === GUARDIAN_OWNER && !visitorsAllowed;
}

/** The reason `share_location` was called with, or why it can't show the card. */
export function parseShareLocationInput(
  input: unknown,
): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = (input as { reason?: unknown } | null)?.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, error: "reason must say, in one short line, why you need the location." };
  }
  return { ok: true, reason: reason.trim().slice(0, MAX_REASON_LENGTH) };
}

/**
 * What a `share_location` call that shows the card hands back. The turn waits
 * on the card; `builtin: true` marks it as core's own, which the drain checks
 * against the tool that emitted it.
 */
export function shareLocationToolOutput(reason: string): unknown {
  return {
    pendingInteraction: true,
    appId: "core",
    render: { kind: "inline", componentId: LOCATION_CARD_ID, props: { reason }, builtin: true },
    message:
      "The card asking for the guardian's location has been shown. Whether they shared it or " +
      "not arrives as the next turn's prompt — do not call any further tools or send another " +
      "message until then.",
  };
}

/** The card described as data, for the reason a stored card's props give, or
 *  null when they give none. */
export function locationCardUiFromProps(props: unknown): WidgetUi | null {
  const reason = (props as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? locationCardUi(reason) : null;
}

/**
 * The answer a Share event's context makes, or null when the context holds no
 * position. A client reads the position from the device and sends it as it is.
 */
export function sharedLocationAnswer(context: Record<string, unknown>): LocationAnswer | null {
  const { latitude, longitude, accuracy, timestamp } = context;
  if (
    !isFiniteNumber(latitude) ||
    !isFiniteNumber(longitude) ||
    !isFiniteNumber(accuracy) ||
    !isFiniteNumber(timestamp) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    accuracy < 0
  ) {
    return null;
  }
  const fixedAt = new Date(timestamp);
  if (Number.isNaN(fixedAt.getTime())) return null;
  return {
    status: "shared",
    latitude,
    longitude,
    accuracyMeters: Math.round(accuracy),
    fixedAt: fixedAt.toISOString(),
  };
}

/** The answer Not now makes. */
export const DECLINED_LOCATION: LocationAnswer = { status: "declined", dismissed: true };

/** What the chat keeps of an answer: how the card ended and how precise a
 *  shared position was, without the position itself. */
export function storedLocationAnswer(output: unknown): Record<string, unknown> {
  const answer = output as Partial<Extract<LocationAnswer, { status: "shared" }>> | null;
  if (answer?.status !== "shared") return { ...DECLINED_LOCATION };
  return { status: "shared", accuracyMeters: answer.accuracyMeters, fixedAt: answer.fixedAt };
}

/** What the agent reads when the card is answered. */
export function locationAnswerPrompt(output: unknown): string {
  const answer = output as Partial<Extract<LocationAnswer, { status: "shared" }>> | null;
  if (answer?.status !== "shared") {
    return (
      "The guardian chose not to share their location for this message. Don't show the card " +
      "again for it: answer without it, or ask them in a message which place they mean. This " +
      "covers this message only: when a later message again needs where they are now, call " +
      "share_location again."
    );
  }
  const coarse = (answer.accuracyMeters ?? Number.POSITIVE_INFINITY) > COARSE_ACCURACY_METERS;
  return (
    "The guardian shared their current location for this answer only:\n\n" +
    `- latitude: ${answer.latitude}\n- longitude: ${answer.longitude}\n` +
    `- accuracy: ±${answer.accuracyMeters} m\n- taken at: ${answer.fixedAt}\n\n` +
    "Use your own tools to turn it into a place if you need one. " +
    (coarse
      ? "The fix is coarse (it may come from the network or a VPN), so name only the area, " +
        'such as "around <city>", and say it is approximate.'
      : "") +
    "Don't keep the position: it is for this turn only."
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

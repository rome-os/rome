// The share-location card `share_location` shows, described as data. Core
// stores it with the card and answers its events; a client draws it like any
// card and fills in the device's position when Share is pressed.

import type { WidgetUi } from "@rome-os/app-runtime";

/** The kind of the share-location card among core's own widgets. */
export const LOCATION_CARD_ID = "location-card";

/**
 * The event Share fires. It is the one event a client fills in itself: before
 * sending it, the client reads the device's position and puts it in the
 * event's context as a {@link SharedPosition}.
 */
export const SHARE_LOCATION_EVENT = "share-location";

/** The event Not now fires. */
export const DECLINE_LOCATION_EVENT = "decline";

/** The context a client sends with {@link SHARE_LOCATION_EVENT}. */
export interface SharedPosition {
  latitude: number;
  longitude: number;
  /** The radius of the fix, in meters. */
  accuracy: number;
  /** When the device took the fix, in milliseconds since the epoch. */
  timestamp: number;
}

/** What the agent waiting on the card is answered with, and what the chat stores. */
export type LocationAnswer =
  | {
      status: "shared";
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      /** When the device took the fix, as an ISO time. */
      fixedAt: string;
    }
  | { status: "declined"; dismissed: true };

/**
 * The card described as data: a title, the agent's reason, and Not now and
 * Share.
 */
export function locationCardUi(reason: string): WidgetUi {
  return {
    components: [
      { id: "root", component: "Column", children: ["title", "reason", "actions"] },
      { id: "title", component: "Text", text: "Share your location?", variant: "h5" },
      { id: "reason", component: "Text", text: reason },
      { id: "actions", component: "Row", children: ["decline", "share"], justify: "end" },
      {
        id: "decline",
        component: "Button",
        child: "decline-label",
        variant: "borderless",
        action: { event: { name: DECLINE_LOCATION_EVENT } },
      },
      { id: "decline-label", component: "Text", text: "Not now" },
      {
        id: "share",
        component: "Button",
        child: "share-label",
        variant: "primary",
        action: { event: { name: SHARE_LOCATION_EVENT } },
      },
      { id: "share-label", component: "Text", text: "Share" },
    ],
  };
}

/** Whether a card's components hold the share-location card's Share. */
export function isLocationCard(components: readonly unknown[]): boolean {
  return components.some((c) => {
    const event = (c as { action?: { event?: { name?: unknown } } } | null)?.action?.event;
    return event?.name === SHARE_LOCATION_EVENT;
  });
}

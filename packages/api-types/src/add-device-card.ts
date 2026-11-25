// The card `system:add_device` shows: the Devices page's ways to add a device,
// each with its instructions. The web draws it itself; core also stores it
// described as data, which any other reader draws as a short card that opens
// the Devices page. Core answers its events (widget-events.ts).

import type { WidgetUi } from "@rome-os/app-runtime";
import { z } from "zod";
import { promptCardUi } from "./prompt-card.js";

/** The kind of the add-device card among core's own cards. */
export const ADD_DEVICE_CARD_ID = "add-device-card";

/** The event Open Devices fires: answers when a new device is listed, else
 *  opens the Devices page. */
export const OPEN_DEVICES_EVENT = "open-devices";

/** The event a client sends with no button for it, once it sees a device the
 *  props do not list: answers when core lists one too. */
export const CHECK_DEVICES_EVENT = "check";

/** The event Not now fires. */
export const DISMISS_ADD_DEVICE_EVENT = "dismiss";

/** The card's props. `deviceIds` are the devices the account had when the
 *  card was sent; the card answers once a device not among them is listed.
 *  Without them, as when Rome Cloud's list could not be read, the card never
 *  answers itself. */
export const addDeviceCardPropsSchema = z.object({
  deviceIds: z.array(z.string()).optional(),
});
export type AddDeviceCardProps = z.infer<typeof addDeviceCardPropsSchema>;

/** What the agent waiting on the card is answered with. */
export type AddDeviceAnswer = { added: true; deviceId: string; name: string } | { dismissed: true };

/** The card described as data: a title, where to add the device, then Not now
 *  and Open Devices. */
export function addDeviceCardUi(): WidgetUi {
  return promptCardUi({
    title: "Add a device",
    note: "Link a computer or phone in Settings › Devices. This card answers once it's added.",
    dismiss: { label: { rome: "notNow", english: "Not now" }, event: DISMISS_ADD_DEVICE_EVENT },
    confirm: { label: "Open Devices", event: OPEN_DEVICES_EVENT },
  });
}

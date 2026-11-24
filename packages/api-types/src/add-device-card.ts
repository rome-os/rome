// The card `system:add_device` shows: the Devices page's ways to add a device,
// each with its instructions. A client that does not know it draws the row it
// gives any card it cannot draw.

import { z } from "zod";

/** The kind of the add-device card among core's own cards. */
export const ADD_DEVICE_CARD_ID = "add-device-card";

/** The card's props. `deviceIds` are the devices the account had when the
 *  card was sent; the card answers once a device not among them is listed.
 *  Without them, as when Rome Cloud's list could not be read, the card never
 *  answers itself. */
export const addDeviceCardPropsSchema = z.object({
  deviceIds: z.array(z.string()).optional(),
});
export type AddDeviceCardProps = z.infer<typeof addDeviceCardPropsSchema>;

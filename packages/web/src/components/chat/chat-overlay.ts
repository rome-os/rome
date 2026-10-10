/**
 * Fits a chat popover to a phone screen. Spread both onto `PopoverContent`:
 * the popover then keeps the chat's phone gutter (`px-3`) from each viewport
 * edge and caps its width to the space left. Desktop widths are unchanged.
 */
export const CHAT_POPOVER_FIT = {
  collisionPadding: 12,
  className: "max-w-(--radix-popover-content-available-width)",
} as const;

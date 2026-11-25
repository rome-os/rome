/**
 * The shape of a link code: `ROME-` and eight letters or digits. The dashboard
 * no longer issues codes and Rome redeems none; Discord's inbound text still
 * reads a code-shaped message as a bare command (connections/kinds/discord).
 */

const CODE_PATTERN = /^ROME-[A-Z0-9]{8}$/i;

export function isLinkCodeMessage(text: string | undefined): boolean {
  return CODE_PATTERN.test(text?.trim() ?? "");
}

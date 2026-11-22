// Rome Cloud signs every Slack event it forwards with the workspace's forward
// secret, which only it and this instance hold. The relay mailbox's deposit
// address is half-public, so a frame counts only when this signature holds. It
// must compute exactly what rome-cloud packages/pantheon/src/lib/slack-app/
// signatures.ts `forwardSignature` computes.

import { createHmac, timingSafeEqual } from "node:crypto";

export const FORWARD_TEAM_HEADER = "x-rome-slack-team";
export const FORWARD_SIGNATURE_HEADER = "x-rome-slack-signature";
export const FORWARD_TIMESTAMP_HEADER = "x-rome-slack-timestamp";

/** `v1=` HMAC-SHA256 under the forward secret of `v1:<timestamp>:<teamId>:<body>`. */
export function forwardSignature(input: {
  forwardSecret: string;
  timestamp: string;
  teamId: string;
  body: Uint8Array;
}): string {
  return `v1=${createHmac("sha256", input.forwardSecret)
    .update(`v1:${input.timestamp}:${input.teamId}:`)
    .update(input.body)
    .digest("hex")}`;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * Whether a drained frame was forwarded by Rome Cloud for `teamId`. There is
 * no freshness window: an event waits in the mailbox while the instance is
 * stopped, and redelivery is caught by the event id instead.
 */
export function isForwardedBy(input: {
  headers: Record<string, string>;
  body: Uint8Array;
  forwardSecret: string;
  teamId: string;
}): boolean {
  const timestamp = header(input.headers, FORWARD_TIMESTAMP_HEADER);
  const signature = header(input.headers, FORWARD_SIGNATURE_HEADER);
  const team = header(input.headers, FORWARD_TEAM_HEADER);
  if (!timestamp || !signature || team !== input.teamId) return false;
  const expected = Buffer.from(
    forwardSignature({
      forwardSecret: input.forwardSecret,
      timestamp,
      teamId: input.teamId,
      body: input.body,
    }),
  );
  const received = Buffer.from(signature);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

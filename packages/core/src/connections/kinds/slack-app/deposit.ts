// The Slack gateway Worker deposits each Slack event for this instance into the
// instance's relay mailbox, signed with the deposit key the Worker gave this
// instance at connect. The mailbox's deposit address is half-public, so a frame
// counts only when this signature holds. It must compute exactly what
// rome-cloud gateway/src/slack/deposit.ts `postDeposit` computes.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The headers the Worker stamps on a deposit. */
export const SLACK_DEPOSIT_HEADER = "x-rome-slack";
export const SLACK_SIGNATURE_HEADER = "x-rome-slack-signature";

/** Hex HMAC-SHA256 of the exact body, keyed with the deposit key's text. */
export function depositSignature(body: Uint8Array, depositKey: string): string {
  return createHmac("sha256", depositKey).update(body).digest("hex");
}

/** A header of a drained frame, whatever its case. */
export function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** Whether a drained frame is one the Slack gateway Worker deposited. */
export function isSlackFrame(headers: Record<string, string>): boolean {
  return headerOf(headers, SLACK_DEPOSIT_HEADER) === "1";
}

/**
 * Whether a drained frame was deposited by the Worker for this instance. There
 * is no freshness window: an event waits in the mailbox while the instance is
 * stopped, and redelivery is caught by the event id instead.
 */
export function isDepositedFor(input: {
  headers: Record<string, string>;
  body: Uint8Array;
  depositKey: string;
}): boolean {
  const signature = headerOf(input.headers, SLACK_SIGNATURE_HEADER);
  if (!signature || !input.depositKey) return false;
  const expected = Buffer.from(depositSignature(input.body, input.depositKey));
  const received = Buffer.from(signature.trim().toLowerCase());
  return received.length === expected.length && timingSafeEqual(received, expected);
}

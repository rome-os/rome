import { z } from "zod";

export const SLACK_RELAY_ENVELOPE_VERSION = 1 as const;
export const SLACK_RELAY_CONTENT_TYPE_HEADER = "Content-Type";
export const SLACK_RELAY_CONTENT_TYPE = "application/json";
export const SLACK_RELAY_ENVELOPE_VERSION_HEADER = "X-Rome-Slack-Envelope-Version";
export const SLACK_RELAY_ENVELOPE_VERSION_HEADER_VALUE = "1";
export const SLACK_RELAY_SIGNATURE_HEADER = "X-Rome-Slack-Signature";

/** Wire constants for the installation-scoped Cloud-to-Rome HMAC. */
export const SLACK_RELAY_HMAC_V1 = {
  algorithm: "HMAC-SHA256",
  keyEncoding: "base64url",
  signatureVersion: "v1",
  signatureBasePrefix: "v1:",
  signatureEncoding: "lowercase-hex",
} as const;

const identifierSchema = z.string().min(1);
// Unpadded, canonical base64url for exactly 32 bytes. The final sextet has two zero pad bits.
const relayHmacKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "expected base64url for 32 bytes");

export const slackInstallationGrantV1Schema = z
  .object({
    schemaVersion: z.literal(SLACK_RELAY_ENVELOPE_VERSION),
    installationId: z.uuid(),
    teamId: identifierSchema,
    installerUserId: identifierSchema,
    botUserId: identifierSchema,
    botScopes: z.array(identifierSchema),
    userScopes: z.array(identifierSchema),
    relayHmacKey: relayHmacKeySchema,
  })
  .strict();

export type SlackInstallationGrantV1 = z.infer<typeof slackInstallationGrantV1Schema>;

const slackMessagePayloadV1Schema = z
  .object({
    kind: z.literal("message"),
    messageType: z.enum(["app_mention", "message"]),
    addressing: z.enum(["direct", "mention", "ambient"]),
    channelId: identifierSchema,
    channelType: z.enum(["im", "channel", "group", "mpim"]),
    senderUserId: identifierSchema,
    messageTs: identifierSchema,
    threadTs: identifierSchema.nullable(),
    text: z.string(),
  })
  .strict();

const slackLifecyclePayloadV1Schema = z
  .object({
    kind: z.literal("lifecycle"),
    reason: z.enum([
      "app_uninstalled",
      "bot_token_revoked",
      "user_token_revoked",
      "provider_authorization_failed",
    ]),
  })
  .strict();

const slackRelayEnvelopeV1CommonShape = {
  schemaVersion: z.literal(SLACK_RELAY_ENVELOPE_VERSION),
  installationId: z.uuid(),
  teamId: identifierSchema,
  slackEventId: identifierSchema,
  occurredAt: z.iso.datetime({ offset: true }),
} as const;

/** Builds the durable message identity carried by every message envelope. */
export function buildSlackProviderMessageKeyV1(
  teamId: string,
  channelId: string,
  messageTs: string,
): string {
  return `${teamId}/${channelId}/${messageTs}`;
}

export const slackRelayEnvelopeV1Schema = z.union([
  z
    .object({
      ...slackRelayEnvelopeV1CommonShape,
      providerMessageKey: identifierSchema,
      payload: slackMessagePayloadV1Schema,
    })
    .strict()
    .refine(
      (envelope) =>
        envelope.providerMessageKey ===
        buildSlackProviderMessageKeyV1(
          envelope.teamId,
          envelope.payload.channelId,
          envelope.payload.messageTs,
        ),
      {
        path: ["providerMessageKey"],
        message: "must match teamId/channelId/messageTs",
      },
    ),
  z
    .object({
      ...slackRelayEnvelopeV1CommonShape,
      providerMessageKey: z.never().optional(),
      payload: slackLifecyclePayloadV1Schema,
    })
    .strict(),
]);

export type SlackRelayEnvelopeV1 = z.infer<typeof slackRelayEnvelopeV1Schema>;

/** The exact HTTP header value accepted for the v1 envelope version. */
export const slackRelayEnvelopeVersionHeaderV1Schema = z.literal(
  SLACK_RELAY_ENVELOPE_VERSION_HEADER_VALUE,
);

/** `v1=` followed by a lowercase hex HMAC-SHA256 digest. */
export const slackRelaySignatureHeaderV1Schema = z
  .string()
  .regex(/^v1=[0-9a-f]{64}$/, "expected a v1 lowercase hex HMAC-SHA256 signature");

const SLACK_RELAY_SIGNATURE_BASE_PREFIX_V1_BYTES = Uint8Array.of(0x76, 0x31, 0x3a);

/** Returns the byte-exact HMAC input: ASCII `v1:` followed by the unmodified raw body. */
export function buildSlackRelaySignatureBaseV1(rawBody: Uint8Array): Uint8Array {
  const base = new Uint8Array(SLACK_RELAY_SIGNATURE_BASE_PREFIX_V1_BYTES.length + rawBody.length);
  base.set(SLACK_RELAY_SIGNATURE_BASE_PREFIX_V1_BYTES);
  base.set(rawBody, SLACK_RELAY_SIGNATURE_BASE_PREFIX_V1_BYTES.length);
  return base;
}

import type { SlackInstallationGrantV1, SlackRelayEnvelopeV1 } from "./slack-relay.js";

/** Obviously synthetic key: canonical base64url for 32 zero bytes, never credential material. */
const NON_SECRET_RELAY_HMAC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const validSlackInstallationGrantV1Fixture = {
  schemaVersion: 1,
  installationId: "00000000-0000-4000-8000-000000000001",
  teamId: "T_CONFORMANCE",
  installerUserId: "U_INSTALLER",
  botUserId: "U_BOT",
  botScopes: ["app_mentions:read", "chat:write", "im:history"],
  userScopes: ["search:read"],
  relayHmacKey: NON_SECRET_RELAY_HMAC_KEY,
} as const satisfies SlackInstallationGrantV1;

export const validSlackMessageRelayEnvelopeV1Fixture = {
  schemaVersion: 1,
  installationId: validSlackInstallationGrantV1Fixture.installationId,
  teamId: validSlackInstallationGrantV1Fixture.teamId,
  slackEventId: "Ev_MESSAGE_CONFORMANCE",
  providerMessageKey: "T_CONFORMANCE/C_GENERAL/1712345678.123456",
  occurredAt: "2026-09-23T12:00:00.000Z",
  payload: {
    kind: "message",
    messageType: "app_mention",
    addressing: "mention",
    channelId: "C_GENERAL",
    channelType: "channel",
    senderUserId: "U_SENDER",
    messageTs: "1712345678.123456",
    threadTs: null,
    text: "Rome, check this fixture.",
  },
} as const satisfies SlackRelayEnvelopeV1;

export const validSlackLifecycleRelayEnvelopeV1Fixture = {
  schemaVersion: 1,
  installationId: validSlackInstallationGrantV1Fixture.installationId,
  teamId: validSlackInstallationGrantV1Fixture.teamId,
  slackEventId: "Ev_LIFECYCLE_CONFORMANCE",
  occurredAt: "2026-09-23T12:05:00.000Z",
  payload: { kind: "lifecycle", reason: "app_uninstalled" },
} as const satisfies SlackRelayEnvelopeV1;

export const invalidSlackInstallationGrantV1Fixtures = [
  {
    name: "unknown schema version",
    input: { ...validSlackInstallationGrantV1Fixture, schemaVersion: 2 },
  },
  {
    name: "non-canonical relay key",
    input: {
      ...validSlackInstallationGrantV1Fixture,
      relayHmacKey: `${NON_SECRET_RELAY_HMAC_KEY}=`,
    },
  },
  {
    name: "unknown field",
    input: { ...validSlackInstallationGrantV1Fixture, unexpectedField: true },
  },
] as const;

export const invalidSlackRelayEnvelopeV1Fixtures = [
  {
    name: "unknown schema version",
    input: { ...validSlackMessageRelayEnvelopeV1Fixture, schemaVersion: 2 },
  },
  {
    name: "message without provider message key",
    input: {
      schemaVersion: validSlackMessageRelayEnvelopeV1Fixture.schemaVersion,
      installationId: validSlackMessageRelayEnvelopeV1Fixture.installationId,
      teamId: validSlackMessageRelayEnvelopeV1Fixture.teamId,
      slackEventId: validSlackMessageRelayEnvelopeV1Fixture.slackEventId,
      occurredAt: validSlackMessageRelayEnvelopeV1Fixture.occurredAt,
      payload: validSlackMessageRelayEnvelopeV1Fixture.payload,
    },
  },
  {
    name: "lifecycle with provider message key",
    input: {
      ...validSlackLifecycleRelayEnvelopeV1Fixture,
      providerMessageKey: "T_CONFORMANCE/C_GENERAL/1712345678.123456",
    },
  },
  {
    name: "provider message key contradicts payload identity",
    input: {
      ...validSlackMessageRelayEnvelopeV1Fixture,
      providerMessageKey: "T_OTHER/C_GENERAL/1712345678.123456",
    },
  },
  {
    name: "unknown payload field",
    input: {
      ...validSlackMessageRelayEnvelopeV1Fixture,
      payload: { ...validSlackMessageRelayEnvelopeV1Fixture.payload, rawSlackEvent: {} },
    },
  },
  {
    name: "unsupported lifecycle reason",
    input: {
      ...validSlackLifecycleRelayEnvelopeV1Fixture,
      payload: { kind: "lifecycle", reason: "tokens_revoked" },
    },
  },
] as const;

export const slackRelayHmacV1Fixture = {
  relayHmacKey: NON_SECRET_RELAY_HMAC_KEY,
  rawBody:
    '{"schemaVersion":1,"installationId":"00000000-0000-4000-8000-000000000001","teamId":"T_CONFORMANCE","slackEventId":"Ev_LIFECYCLE_CONFORMANCE","occurredAt":"2026-09-23T12:05:00.000Z","payload":{"kind":"lifecycle","reason":"app_uninstalled"}}',
  signatureBase:
    'v1:{"schemaVersion":1,"installationId":"00000000-0000-4000-8000-000000000001","teamId":"T_CONFORMANCE","slackEventId":"Ev_LIFECYCLE_CONFORMANCE","occurredAt":"2026-09-23T12:05:00.000Z","payload":{"kind":"lifecycle","reason":"app_uninstalled"}}',
  signatureHeader: "v1=85b806fa5bb4d70b00ac079dbff42804325a70ebef3a3093cc10142b030ca3d4",
} as const;

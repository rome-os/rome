import { createHmac } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import {
  invalidSlackInstallationGrantV1Fixtures,
  invalidSlackRelayEnvelopeV1Fixtures,
  slackRelayHmacV1Fixture,
  validSlackInstallationGrantV1Fixture,
  validSlackLifecycleRelayEnvelopeV1Fixture,
  validSlackMessageRelayEnvelopeV1Fixture,
} from "./slack-relay-fixtures.js";
import {
  buildSlackProviderMessageKeyV1,
  buildSlackRelaySignatureBaseV1,
  SLACK_RELAY_CONTENT_TYPE,
  SLACK_RELAY_CONTENT_TYPE_HEADER,
  SLACK_RELAY_ENVELOPE_VERSION_HEADER,
  SLACK_RELAY_ENVELOPE_VERSION_HEADER_VALUE,
  SLACK_RELAY_HMAC_V1,
  SLACK_RELAY_SIGNATURE_HEADER,
  slackInstallationGrantV1Schema,
  slackRelayEnvelopeV1Schema,
  slackRelayEnvelopeVersionHeaderV1Schema,
  slackRelaySignatureHeaderV1Schema,
} from "./slack-relay.js";

describe("Slack installation relay contract v1", () => {
  it("accepts the shared valid fixtures", () => {
    expect(slackInstallationGrantV1Schema.parse(validSlackInstallationGrantV1Fixture)).toEqual(
      validSlackInstallationGrantV1Fixture,
    );
    expect(slackRelayEnvelopeV1Schema.parse(validSlackMessageRelayEnvelopeV1Fixture)).toEqual(
      validSlackMessageRelayEnvelopeV1Fixture,
    );
    expect(slackRelayEnvelopeV1Schema.parse(validSlackLifecycleRelayEnvelopeV1Fixture)).toEqual(
      validSlackLifecycleRelayEnvelopeV1Fixture,
    );
  });

  it("rejects every shared invalid grant fixture", () => {
    for (const fixture of invalidSlackInstallationGrantV1Fixtures) {
      expect(slackInstallationGrantV1Schema.safeParse(fixture.input).success, fixture.name).toBe(
        false,
      );
    }
  });

  it("rejects every shared invalid envelope fixture", () => {
    for (const fixture of invalidSlackRelayEnvelopeV1Fixtures) {
      expect(slackRelayEnvelopeV1Schema.safeParse(fixture.input).success, fixture.name).toBe(false);
    }
  });

  it.each([0, 2, "1", "2", null])("fails closed for grant schema version %j", (schemaVersion) => {
    const input = { ...validSlackInstallationGrantV1Fixture, schemaVersion };
    expect(slackInstallationGrantV1Schema.safeParse(input).success).toBe(false);
  });

  it.each([
    0,
    2,
    "1",
    "2",
    null,
  ])("fails closed for envelope schema version %j", (schemaVersion) => {
    const input = { ...validSlackMessageRelayEnvelopeV1Fixture, schemaVersion };
    expect(slackRelayEnvelopeV1Schema.safeParse(input).success).toBe(false);
  });

  it("pins the outbound header names and HMAC vocabulary", () => {
    expect(SLACK_RELAY_CONTENT_TYPE_HEADER).toBe("Content-Type");
    expect(SLACK_RELAY_CONTENT_TYPE).toBe("application/json");
    expect(SLACK_RELAY_ENVELOPE_VERSION_HEADER).toBe("X-Rome-Slack-Envelope-Version");
    expect(SLACK_RELAY_ENVELOPE_VERSION_HEADER_VALUE).toBe("1");
    expect(SLACK_RELAY_SIGNATURE_HEADER).toBe("X-Rome-Slack-Signature");
    expect(SLACK_RELAY_HMAC_V1).toEqual({
      algorithm: "HMAC-SHA256",
      keyEncoding: "base64url",
      signatureVersion: "v1",
      signatureBasePrefix: "v1:",
      signatureEncoding: "lowercase-hex",
    });
  });

  it("builds the canonical provider message key", () => {
    const envelope = validSlackMessageRelayEnvelopeV1Fixture;
    expect(
      buildSlackProviderMessageKeyV1(
        envelope.teamId,
        envelope.payload.channelId,
        envelope.payload.messageTs,
      ),
    ).toBe(envelope.providerMessageKey);
  });

  it.each(["0", "2", "v1", 1, null])("fails closed for envelope header version %j", (value) => {
    expect(slackRelayEnvelopeVersionHeaderV1Schema.safeParse(value).success).toBe(false);
  });

  it("accepts only a v1 lowercase hex signature header", () => {
    expect(
      slackRelaySignatureHeaderV1Schema.safeParse(slackRelayHmacV1Fixture.signatureHeader).success,
    ).toBe(true);
    for (const signature of [
      slackRelayHmacV1Fixture.signatureHeader.replace("v1=", "v0="),
      slackRelayHmacV1Fixture.signatureHeader.toUpperCase(),
      `${slackRelayHmacV1Fixture.signatureHeader}00`,
      slackRelayHmacV1Fixture.signatureHeader.slice(0, -1),
    ]) {
      expect(slackRelaySignatureHeaderV1Schema.safeParse(signature).success).toBe(false);
    }
  });

  it("builds the byte-exact base without parsing or re-encoding the body", () => {
    const rawBody = new TextEncoder().encode('{ "text": "café" }\n');
    const base = buildSlackRelaySignatureBaseV1(rawBody);

    expect(new TextDecoder().decode(base)).toBe('v1:{ "text": "café" }\n');
    expect(Array.from(base.slice(3))).toEqual(Array.from(rawBody));
  });

  it("matches the shared decoded-key HMAC-SHA256 vector", () => {
    expect(JSON.stringify(validSlackLifecycleRelayEnvelopeV1Fixture)).toBe(
      slackRelayHmacV1Fixture.rawBody,
    );
    const base = buildSlackRelaySignatureBaseV1(
      new TextEncoder().encode(slackRelayHmacV1Fixture.rawBody),
    );
    expect(new TextDecoder().decode(base)).toBe(slackRelayHmacV1Fixture.signatureBase);

    const digest = createHmac(
      "sha256",
      Buffer.from(slackRelayHmacV1Fixture.relayHmacKey, "base64url"),
    )
      .update(base)
      .digest("hex");
    expect(`v1=${digest}`).toBe(slackRelayHmacV1Fixture.signatureHeader);
  });
});

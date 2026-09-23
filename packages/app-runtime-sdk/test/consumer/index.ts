import {
  slackInstallationGrantV1Schema,
  slackRelayEnvelopeV1Schema,
  type SlackInstallationGrantV1,
  type SlackRelayEnvelopeV1,
} from "@rome-os/app-runtime";
import {
  buildSlackProviderMessageKeyV1,
  buildSlackRelaySignatureBaseV1,
  SLACK_RELAY_HMAC_V1,
} from "@rome-os/app-runtime/slack-relay";
import {
  slackRelayHmacV1Fixture,
  validSlackInstallationGrantV1Fixture,
  validSlackMessageRelayEnvelopeV1Fixture,
} from "@rome-os/app-runtime/slack-relay/fixtures";

const grant: SlackInstallationGrantV1 = slackInstallationGrantV1Schema.parse(
  validSlackInstallationGrantV1Fixture,
);
const envelope: SlackRelayEnvelopeV1 = slackRelayEnvelopeV1Schema.parse(
  validSlackMessageRelayEnvelopeV1Fixture,
);
const signatureBase = buildSlackRelaySignatureBaseV1(
  new TextEncoder().encode(slackRelayHmacV1Fixture.rawBody),
);
const providerMessageKey =
  envelope.payload.kind === "message"
    ? buildSlackProviderMessageKeyV1(
        envelope.teamId,
        envelope.payload.channelId,
        envelope.payload.messageTs,
      )
    : undefined;

void [grant, envelope, signatureBase, providerMessageKey, SLACK_RELAY_HMAC_V1];

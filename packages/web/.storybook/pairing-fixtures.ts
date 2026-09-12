import { pairingPayload } from "@rome/api-types/approvals";
import { pairingFixtures } from "../src/pages/dev/pairing-fixtures";
import { pairingPresentation } from "../src/components/pairing/pairing-presentation";

export function pairingStory(channelIndex = 0) {
  const approval = pairingFixtures(Date.UTC(2026, 8, 10, 10, 0))[channelIndex];
  return pairingPresentation(approval, pairingPayload(approval)!, true);
}

export const ignorePairingAction = () => undefined;

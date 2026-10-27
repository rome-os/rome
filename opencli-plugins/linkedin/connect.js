// Tightens the OpenCLI 1.8.8 connect receipt with its sent-invitations reader.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cli, getRegistry } from "@jackwener/opencli/registry";
import {
  canonicalizeLinkedInProfileUrl,
  matchesLinkedInSentInvitation,
} from "./connect-receipt.mjs";

const registry = getRegistry();
let upstreamConnect = registry.get("linkedin/connect");
let sentInvitations = registry.get("linkedin/sent-invitations");

if (typeof upstreamConnect?.func !== "function" || typeof sentInvitations?.func !== "function") {
  const require = createRequire(import.meta.url);
  const opencliRoot = resolve(dirname(require.resolve("@jackwener/opencli/registry")), "..", "..");
  await import(pathToFileURL(join(opencliRoot, "clis/linkedin/sent-invitations.js")).href);
  await import(pathToFileURL(join(opencliRoot, "clis/linkedin/connect.js")).href);
  upstreamConnect = registry.get("linkedin/connect");
  sentInvitations = registry.get("linkedin/sent-invitations");
}

if (typeof upstreamConnect?.func !== "function" || typeof sentInvitations?.func !== "function") {
  throw new Error(
    "OpenCLI LinkedIn connect and sent-invitations commands must load before Rome plugins",
  );
}

function unverifiedReceipt(receipt, reason) {
  return {
    ...receipt,
    status: "send_unverified",
    reason,
    delivery_verified: false,
    matched_invitation_name: "",
    matched_invitation_url: "",
  };
}

cli({
  ...upstreamConnect,
  func: async (page, args) => {
    const receipts = await upstreamConnect.func(page, args);
    if (
      !args?.send ||
      !Array.isArray(receipts) ||
      receipts.length !== 1 ||
      !["sent_verified", "send_unverified"].includes(receipts[0]?.status)
    ) {
      return receipts;
    }

    let invitations;
    try {
      invitations = await sentInvitations.func(page, {});
    } catch {
      return [unverifiedReceipt(receipts[0], "sent_invitation_verification_failed")];
    }

    const match = Array.isArray(invitations)
      ? invitations.find((invitation) =>
          matchesLinkedInSentInvitation(invitation, args["expected-name"], args["profile-url"]),
        )
      : undefined;

    if (!match) {
      return [unverifiedReceipt(receipts[0], "sent_invitation_not_found_after_retries")];
    }

    return [
      {
        ...receipts[0],
        status: "sent_verified",
        reason: "sent_invitation_verified",
        delivery_verified: true,
        matched_invitation_name: match.name,
        matched_invitation_url: canonicalizeLinkedInProfileUrl(match.profile_url),
      },
    ];
  },
});

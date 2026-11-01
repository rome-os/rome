// Replaces OpenCLI's linkedin/connect. Connect detection reads only the profile owner's header
// (connect-profile.mjs), and a send is verified against the sent-invitations reader.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, getRegistry } from "@jackwener/opencli/registry";
import {
  assessConnectability,
  buildConnectPageScript,
  buildInviteDialogScript,
  canonicalizeLinkedInInviteUrl,
  linkedInProfileVanity,
} from "./connect-profile.mjs";
import {
  canonicalizeLinkedInProfileUrl,
  matchesLinkedInSentInvitation,
} from "./connect-receipt.mjs";

const LINKEDIN_DOMAIN = "www.linkedin.com";

const registry = getRegistry();
let upstreamConnect = registry.get("linkedin/connect");
let sentInvitations = registry.get("linkedin/sent-invitations");

// A lazily discovered upstream command registers itself when its module first loads. Loading it
// here, before this file calls cli(), keeps that registration from replacing this override.
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

function unwrap(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) {
    return payload.data;
  }
  return payload;
}

function requiredText(args, key) {
  const value = String(args?.[key] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) throw new ArgumentError(`--${key} is required`);
  return value;
}

function noteOf(args) {
  const note = String(args?.note ?? "")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (note.length > 300) {
    throw new ArgumentError(
      "--note must be 300 characters or fewer for LinkedIn connection requests",
    );
  }
  return note;
}

async function runOnPage(page, options) {
  return unwrap(await page.evaluate(buildConnectPageScript(options)));
}

function settled(probe) {
  return Boolean(
    probe?.authRequired ||
      (probe?.name &&
        probe.headerFound &&
        (probe.firstDegree || probe.pending || probe.connectAvailable || probe.moreAvailable)),
  );
}

async function readProfile(page, options) {
  // The name resolves from document.title before LinkedIn renders the header actions.
  await page.wait(6);
  let probe = await runOnPage(page, { ...options, mode: "probe" });
  for (let attempt = 0; attempt < 8 && !settled(probe); attempt += 1) {
    await page.wait(2);
    probe = await runOnPage(page, { ...options, mode: "probe" });
  }

  let menu = null;
  if (
    probe?.headerFound &&
    probe.moreAvailable &&
    !probe.firstDegree &&
    !probe.pending &&
    !probe.connectAvailable
  ) {
    menu = await runOnPage(page, { ...options, mode: "inspect_more" });
    if (menu?.closed === false && typeof page.pressKey === "function") {
      await page.pressKey("Escape");
    }
  }
  return { probe, menu };
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

async function verifySentInvitation(page, receipt, expectedName, profileUrl) {
  // A new invitation can take several seconds to reach the sent-invitations page.
  await page.wait(8);
  let failed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await page.wait(5);
    let invitations;
    try {
      invitations = await sentInvitations.func(page, {});
      failed = false;
    } catch {
      failed = true;
      continue;
    }
    const match = Array.isArray(invitations)
      ? invitations.find((invitation) =>
          matchesLinkedInSentInvitation(invitation, expectedName, profileUrl),
        )
      : undefined;
    if (match) {
      return {
        ...receipt,
        status: "sent_verified",
        reason: "sent_invitation_verified",
        delivery_verified: true,
        matched_invitation_name: match.name,
        matched_invitation_url: canonicalizeLinkedInProfileUrl(match.profile_url),
      };
    }
  }
  return unverifiedReceipt(
    receipt,
    failed ? "sent_invitation_verification_failed" : "sent_invitation_not_found_after_retries",
  );
}

async function sendInvitation(page, verdict, probe, options, note) {
  let result;
  if (verdict.method === "invite_link") {
    const inviteUrl = canonicalizeLinkedInInviteUrl(probe.connectHref, options.ownerVanity);
    if (!inviteUrl)
      throw new CommandExecutionError("LinkedIn connect blocked: invalid_connect_link");
    await page.goto(inviteUrl);
    await page.wait(6);
    result = unwrap(await page.evaluate(buildInviteDialogScript(note)));
    if (result?.reason === "invite_dialog_not_found") {
      await page.wait(5);
      result = unwrap(await page.evaluate(buildInviteDialogScript(note)));
    }
  } else {
    const opened = await runOnPage(page, { ...options, mode: "activate" });
    if (!opened?.ok) {
      throw new CommandExecutionError(
        `LinkedIn connect blocked: ${opened?.reason || "connect_control_not_found"}`,
      );
    }
    await page.wait(3);
    result = unwrap(await page.evaluate(buildInviteDialogScript(note)));
    if (result?.reason === "invite_dialog_not_found") {
      await page.wait(5);
      result = unwrap(await page.evaluate(buildInviteDialogScript(note)));
    }
    // Activating Connect sent the invitation without a dialog, so the note was not attached.
    if (result?.reason === "invite_dialog_not_found") {
      result = { ok: true, status: "sent", reason: "invitation_sent_no_dialog" };
    }
  }
  if (!result?.ok) {
    throw new CommandExecutionError(`LinkedIn connect blocked: ${result?.reason || "send_failed"}`);
  }
}

cli({
  ...upstreamConnect,
  description:
    "Verify that a LinkedIn profile owner can be invited to connect, and optionally send the invitation. Dry runs never activate Connect.",
  args: [
    {
      name: "profile-url",
      type: "string",
      required: true,
      positional: true,
      help: "Exact LinkedIn profile URL to open and verify",
    },
    {
      name: "expected-name",
      type: "string",
      required: true,
      help: "Expected visible profile name",
    },
    {
      name: "note",
      type: "string",
      required: false,
      default: "",
      help: "Optional connection note, max 300 chars. LinkedIn drops it when Connect sends immediately.",
    },
    {
      name: "send",
      type: "bool",
      required: false,
      default: false,
      help: "Activate Connect and send the invitation. LinkedIn can send it the moment Connect is activated, with no dialog. Default is a dry run that never activates Connect.",
    },
  ],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError("Browser session required for linkedin connect");
    const profileUrl = canonicalizeLinkedInProfileUrl(requiredText(args, "profile-url"));
    if (!profileUrl) {
      throw new ArgumentError(
        "--profile-url must be an exact https://www.linkedin.com/in/<profile>/ URL",
      );
    }
    const expectedName = requiredText(args, "expected-name");
    const note = noteOf(args);
    const options = { expectedName, ownerVanity: linkedInProfileVanity(profileUrl) };

    await page.goto(profileUrl);
    const { probe, menu } = await readProfile(page, options);
    const verdict = assessConnectability(probe, menu, expectedName, profileUrl);
    const receipt = {
      recipient: verdict.actualValue,
      reason: "",
      profile_url: verdict.observedUrl,
      note_chars: note.length,
    };

    if (verdict.blockReason === "auth_required") {
      throw new AuthRequiredError(
        LINKEDIN_DOMAIN,
        "LinkedIn connect requires an active signed-in LinkedIn browser session.",
      );
    }
    if (verdict.safety === "routine_non_connectable") {
      return [
        { status: "not_connectable", ...receipt, reason: verdict.blockReason, connectable: false },
      ];
    }
    if (!verdict.ok) {
      throw new CommandExecutionError(
        `LinkedIn connect blocked: ${verdict.blockReason}`,
        `Expected ${verdict.expectedValue}; actual ${verdict.actualValue || "not_visible"} at ${verdict.observedUrl || "url_not_available"}\nHeader actions: ${(probe?.buttonLabels || []).join(" | ")}`,
      );
    }
    if (!args.send) {
      return [
        {
          status: "connectable_dry_run",
          ...receipt,
          reason: verdict.blockReason,
          connectable: true,
        },
      ];
    }

    await sendInvitation(page, verdict, probe, options, note);
    return [
      await verifySentInvitation(
        page,
        { status: "send_unverified", ...receipt, connectable: true },
        expectedName,
        profileUrl,
      ),
    ];
  },
});

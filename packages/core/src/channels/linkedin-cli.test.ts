import { describe, expect, it } from "@rstest/core";
import {
  OpencliAuthError,
  OpencliCommandError,
  parseInbox,
  parseLinkedInReply,
  parseThreadParticipants,
  parseThreadSnapshot,
  parseWhoami,
  type OpencliResult,
} from "./linkedin-cli.js";

function ok(stdout: string): OpencliResult {
  return { code: 0, stdout, stderr: "" };
}

describe("parseLinkedInReply", () => {
  const receipt = {
    status: "sent",
    thread_id: "thread",
    message_id: "provider-id",
    sender_is_self: true,
    sent_at: "2026-09-09T12:00:00Z",
  };

  it("requires a sent message with a provider id on the requested thread", () => {
    expect(parseLinkedInReply(ok(JSON.stringify([receipt])), "thread")).toMatchObject({
      messageId: "provider-id",
      threadId: "thread",
      senderIsSelf: true,
    });
    for (const row of [
      { ...receipt, status: "verified_dry_run" },
      { ...receipt, thread_id: "other" },
      { ...receipt, message_id: "" },
      { ...receipt, sender_is_self: false },
      { ...receipt, sent_at: "invalid" },
    ]) {
      expect(() => parseLinkedInReply(ok(JSON.stringify([row])), "thread")).toThrow(
        "outcome is unknown",
      );
    }
  });

  it("keeps the stored text's line breaks and whether it matched the sent text", () => {
    const text = "See https://example.com/demo\n\nExample signature";
    expect(
      parseLinkedInReply(ok(JSON.stringify([{ ...receipt, text, text_matches: false }])), "thread"),
    ).toMatchObject({ text, textMatches: false });
    expect(parseLinkedInReply(ok(JSON.stringify([receipt])), "thread").textMatches).toBeNull();
  });

  it("reports killed commands and malformed output as unknown, while preserving auth failures", () => {
    expect(() =>
      parseLinkedInReply({ code: null, stdout: "", stderr: "timeout" }, "thread"),
    ).toThrow("Check LinkedIn before retrying");
    expect(() => parseLinkedInReply(ok("invalid JSON"), "thread")).toThrow(
      "Check LinkedIn before retrying",
    );
    expect(() =>
      parseLinkedInReply({ code: 1, stdout: "", stderr: "auth_required" }, "thread"),
    ).toThrow(OpencliAuthError);
  });
});

describe("parseWhoami", () => {
  it("returns the account of a signed-in session", () => {
    const identity = parseWhoami(
      ok(
        JSON.stringify({
          logged_in: true,
          site: "linkedin",
          public_id: "jane-doe",
          plain_id: "12345",
          name: "Jane Doe",
        }),
      ),
    );
    expect(identity).toEqual({ publicId: "jane-doe", plainId: "12345", name: "Jane Doe" });
  });

  it("treats a clean logged_in: false as an auth error, not a command failure", () => {
    expect(() => parseWhoami(ok(JSON.stringify({ logged_in: false })))).toThrow(OpencliAuthError);
  });

  it("treats an unexpected shape as transient", () => {
    expect(() => parseWhoami(ok(JSON.stringify({ nope: 1 })))).toThrow(OpencliCommandError);
  });
});

describe("failure classification", () => {
  it("classifies an auth-marked failure as OpencliAuthError", () => {
    const result: OpencliResult = {
      code: 69,
      stdout: "ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: sign in first",
      stderr: "",
    };
    expect(() => parseInbox(result)).toThrow(OpencliAuthError);
  });

  it("classifies the plugin's auth-wall phrasing as OpencliAuthError", () => {
    const result: OpencliResult = {
      code: 1,
      stdout: "",
      stderr: "Error: reading this thread requires an active signed-in LinkedIn browser session.",
    };
    expect(() => parseThreadSnapshot(result)).toThrow(OpencliAuthError);
  });

  it("classifies any other non-zero exit as transient", () => {
    const result: OpencliResult = {
      code: 69,
      stdout: "ok: false\nerror:\n  code: BROWSER_CONNECT\n  message: extension not connected",
      stderr: "",
    };
    expect(() => parseInbox(result)).toThrow(OpencliCommandError);
  });

  it("classifies empty output as transient", () => {
    expect(() => parseInbox(ok(""))).toThrow(OpencliCommandError);
  });

  it("classifies unparseable exit-0 output with an auth marker as auth", () => {
    expect(() => parseInbox(ok("ok: false\nerror: not logged in"))).toThrow(OpencliAuthError);
  });
});

describe("parseInbox", () => {
  it("maps listing rows, parsing the ISO timestamp", () => {
    const rows = parseInbox(
      ok(
        JSON.stringify([
          {
            rank: 1,
            thread_url: "https://www.linkedin.com/messaging/thread/2-abc==/",
            thread_id: "2-abc==",
            person_name: "Ada Lovelace",
            last_message_preview: "See you Sunday?",
            unread: true,
            counterparty_type: "member",
            category: "INBOX,PRIMARY_INBOX",
            timestamp: "2026-08-19T20:52:09.488Z",
          },
        ]),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].threadId).toBe("2-abc==");
    expect(rows[0].unread).toBe(true);
    expect(rows[0].lastMessageAt?.toISOString()).toBe("2026-08-19T20:52:09.488Z");
  });

  it("tolerates missing optional fields and bad timestamps", () => {
    const rows = parseInbox(
      ok(
        JSON.stringify([{ thread_url: "https://x/", thread_id: "t1", timestamp: "yesterday-ish" }]),
      ),
    );
    expect(rows[0].rank).toBe(1);
    expect(rows[0].personName).toBeNull();
    expect(rows[0].unread).toBe(false);
    expect(rows[0].lastMessageAt).toBeNull();
  });
});

describe("parseThreadSnapshot", () => {
  it("maps message rows, folding an empty sent_at to null", () => {
    const messages = parseThreadSnapshot(
      ok(
        JSON.stringify([
          {
            thread_url: "https://x/",
            thread_id: "t1",
            conversation_name: "",
            returned_index: 1,
            returned_message_count: 2,
            message_id: "m1",
            sent_at: "2026-08-19T20:52:09.488Z",
            sender_participant_id: "ACoAAAda0001",
            sender_name: "Ada Lovelace",
            sender_type: "member",
            sender_profile_url: "https://www.linkedin.com/in/ada/",
            sender_headline: "Engineer",
            sender_is_self: false,
            text: "See you Sunday?",
            subject: "",
            reaction_count: 1,
            is_latest: false,
          },
          {
            thread_id: "t1",
            message_id: "m2",
            sent_at: "",
            sender_is_self: true,
            text: "Yes!",
          },
        ]),
      ),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].sentAt?.toISOString()).toBe("2026-08-19T20:52:09.488Z");
    expect(messages[0].senderParticipantId).toBe("ACoAAAda0001");
    expect(messages[0].reactionCount).toBe(1);
    expect(messages[1].sentAt).toBeNull();
    expect(messages[1].senderIsSelf).toBe(true);
    // Rows from a pre-0.2.0 plugin carry no group metadata: unknown, not 1:1.
    expect(messages[1].conversationIsGroup).toBeNull();
    expect(messages[1].conversationTitle).toBeNull();
    expect(messages[1].participantCount).toBeNull();
  });

  it("carries the authoritative group metadata separately from the display name", () => {
    const messages = parseThreadSnapshot(
      ok(
        JSON.stringify([
          {
            thread_id: "t1",
            message_id: "m1",
            conversation_name: "Evan Ye",
            conversation_title: "",
            conversation_is_group: false,
            participant_count: 2,
            sent_at: "2026-08-19T20:52:09.488Z",
            sender_is_self: false,
            text: "hi",
          },
          {
            thread_id: "t2",
            message_id: "m2",
            conversation_name: "Pitch review",
            conversation_title: "Pitch review",
            conversation_is_group: true,
            participant_count: 3,
            sent_at: "2026-08-19T20:52:09.488Z",
            sender_is_self: false,
            text: "notes",
          },
        ]),
      ),
    );
    // A 1:1 whose conversation_name is the counterparty's name stays 1:1.
    expect(messages[0].conversationIsGroup).toBe(false);
    expect(messages[0].conversationTitle).toBeNull();
    expect(messages[1].conversationIsGroup).toBe(true);
    expect(messages[1].conversationTitle).toBe("Pitch review");
    expect(messages[1].participantCount).toBe(3);
  });
});

describe("parseThreadParticipants", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    thread_url: "https://www.linkedin.com/messaging/thread/2-abc==/",
    thread_id: "2-abc==",
    participant_index: 1,
    participant_count: 2,
    participant_id: "ACoAAAda0001",
    name: "Ada Lovelace",
    headline: "Engineer",
    type: "member",
    is_self: false,
    profile_url: "https://www.linkedin.com/in/ACoAAAda0001/",
    ...overrides,
  });

  it("returns one record per participant, member id first", () => {
    const participants = parseThreadParticipants(
      ok(
        JSON.stringify([
          row(),
          row({
            participant_index: 2,
            participant_id: "ACoAASelf0003",
            name: "Jane Doe",
            headline: "",
            is_self: true,
          }),
        ]),
      ),
    );

    expect(participants).toEqual([
      {
        threadId: "2-abc==",
        participantId: "ACoAAAda0001",
        name: "Ada Lovelace",
        headline: "Engineer",
        type: "member",
        isSelf: false,
        profileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
      },
      {
        threadId: "2-abc==",
        participantId: "ACoAASelf0003",
        name: "Jane Doe",
        // The plugin writes "" for a field it could not read; the mirror stores
        // "not known" as null so a later read can still fill it in.
        headline: null,
        type: "member",
        isSelf: true,
        profileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
      },
    ]);
  });

  it("keeps a participant who has sent no message in the thread", () => {
    // The conversation payload names everyone; a lurker only ever appears here.
    const participants = parseThreadParticipants(
      ok(JSON.stringify([row(), row({ participant_index: 2, participant_id: "ACoAALurk0002" })])),
    );
    expect(participants.map((p) => p.participantId)).toEqual(["ACoAAAda0001", "ACoAALurk0002"]);
  });

  it("drops rows with no member id rather than storing a blank account", () => {
    const participants = parseThreadParticipants(
      ok(JSON.stringify([row(), row({ participant_index: 2, participant_id: "" })])),
    );
    expect(participants.map((p) => p.participantId)).toEqual(["ACoAAAda0001"]);
  });

  it("fails closed on an auth wall, matching thread-snapshot", () => {
    expect(() =>
      parseThreadParticipants({
        code: 1,
        stdout: "",
        stderr: "AuthRequiredError: authwall — sign in to LinkedIn",
      }),
    ).toThrow(OpencliAuthError);
  });

  it("fails on an unexpected output shape", () => {
    expect(() => parseThreadParticipants(ok(JSON.stringify([{ name: "Ada" }])))).toThrow(
      OpencliCommandError,
    );
  });

  it("fails when the thread reports no participants at all", () => {
    // An empty read must never reach the store: the store treats an empty set
    // as "everyone left" and would wipe the thread's membership.
    expect(() => parseThreadParticipants(ok(JSON.stringify([])))).toThrow(OpencliCommandError);
  });
});

describe("OpenCLI 2 result envelopes", () => {
  const envelope = (data: unknown) => ok(JSON.stringify({ ok: true, data }));
  const failure = (code: number, error: Record<string, unknown>): OpencliResult => ({
    code,
    stdout: `${JSON.stringify({ ok: false, error: { ...error, exitCode: code } })}\n`,
    stderr: "",
  });
  const receipt = {
    status: "sent",
    thread_id: "thread",
    message_id: "provider-id",
    sender_is_self: true,
    sent_at: "2026-09-09T12:00:00Z",
  };

  it("reads each command's data the same as OpenCLI 1.8's bare output", () => {
    const identity = { logged_in: true, site: "linkedin", public_id: "jane-doe", name: "Jane Doe" };
    expect(parseWhoami(envelope(identity))).toEqual(parseWhoami(ok(JSON.stringify(identity))));

    const inbox = [{ thread_url: "https://x/", thread_id: "t1", unread: true }];
    expect(parseInbox(envelope(inbox))).toEqual(parseInbox(ok(JSON.stringify(inbox))));

    const participants = [
      { thread_id: "t1", participant_id: "ACoAAAda0001", name: "Ada Lovelace", is_self: false },
    ];
    expect(parseThreadParticipants(envelope(participants))).toEqual(
      parseThreadParticipants(ok(JSON.stringify(participants))),
    );

    expect(parseLinkedInReply(envelope([receipt]), "thread")).toMatchObject({
      messageId: "provider-id",
      threadId: "thread",
    });
  });

  it("classifies an AUTH_REQUIRED envelope as OpencliAuthError with its message and hint", () => {
    const signedOut = failure(77, {
      code: "AUTH_REQUIRED",
      message: "LinkedIn li_at cookie missing",
      hint: "Please open Chrome or Chromium and log in to https://linkedin.com",
    });
    expect(() => parseWhoami(signedOut)).toThrow(
      "LinkedIn li_at cookie missing (AUTH_REQUIRED). Please open Chrome or Chromium and log in to https://linkedin.com",
    );
    expect(() => parseInbox(signedOut)).toThrow(OpencliAuthError);
    expect(() => parseLinkedInReply(signedOut, "thread")).toThrow(OpencliAuthError);
  });

  it("names the envelope's message and code for any other failure", () => {
    const disconnected = failure(69, {
      code: "BROWSER_CONNECT",
      message: "Browser Bridge extension not connected",
    });
    expect(() => parseThreadSnapshot(disconnected)).toThrow(OpencliCommandError);
    expect(() => parseThreadSnapshot(disconnected)).toThrow(
      "opencli linkedin thread-snapshot failed: Browser Bridge extension not connected (BROWSER_CONNECT)",
    );
  });

  it("keeps the plugin's auth-wall phrasing inside an envelope as an auth failure", () => {
    const authWall = failure(1, {
      code: "COMMAND_EXEC",
      message: "reading this thread requires an active signed-in LinkedIn browser session.",
    });
    expect(() => parseThreadParticipants(authWall)).toThrow(OpencliAuthError);
  });

  it("treats an error envelope that exits 0 as a failure, not as data", () => {
    const result = { ...failure(0, { code: "COMMAND_EXEC", message: "empty page" }), code: 0 };
    expect(() => parseInbox(result)).toThrow("empty page (COMMAND_EXEC)");
  });

  it("reports a reply whose browser step may still have run as an unknown outcome", () => {
    const timedOut = failure(75, {
      code: "command_result_unknown",
      message: "Browser exec command timed out after 120s; it may still complete in the browser.",
      outcome: "unknown",
    });
    expect(() => parseLinkedInReply(timedOut, "thread")).toThrow(
      "Send outcome is unknown. Check LinkedIn before retrying.",
    );
  });
});

import { describe, expect, it } from "@rstest/core";
import { LINEAR_WATCHABLE } from "./index.js";
import { mentionsViewer, normalizeLinear } from "./normalize.js";
import type { LinearIssuePeople, LinearViewer } from "./reads.js";

// Payloads shaped as Linear's webhook bodies, which Composio's public-team
// triggers pass on as `actor`, `createdAt`, `data`, `organizationId` and `url`
// (docs.composio.dev/toolkits/linear). `updatedFrom` is Linear's own field;
// Composio's docs do not list it.
const viewer: LinearViewer = {
  id: "u-me",
  name: "Mia Chen",
  displayName: "mia",
  email: "mia@x.io",
};
const ALL = new Set(LINEAR_WATCHABLE.kinds.map((k) => k.kind));
const ctx = (kinds: ReadonlySet<string> = ALL, people?: LinearIssuePeople) => ({
  kinds,
  reads: {
    linearViewer: async () => viewer,
    linearIssue: async () => people ?? { subscriberIds: [] },
  },
});
const CREATED = "linear_public_team_issue_created";
const UPDATED = "linear_public_team_issue_properties_updated";
const COMMENT = "linear_public_team_comment_created";

const issue = (extra: Record<string, unknown> = {}) => ({
  id: "iss-1",
  identifier: "ENG-42",
  title: "Checkout times out",
  description: "Steps in the doc",
  url: "https://linear.app/acme/issue/ENG-42",
  priorityLabel: "Urgent",
  assigneeId: "u-me",
  creatorId: "u-bo",
  stateId: "st-2",
  state: { id: "st-2", name: "In Progress", type: "started" },
  team: { id: "t-1", key: "ENG", name: "Engineering" },
  subscriberIds: ["u-bo"],
  updatedAt: "2026-11-04T10:00:00.000Z",
  ...extra,
});
const hook = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  action: "update",
  actor: { id: "u-bo", name: "Bo Diaz", type: "user" },
  createdAt: "2026-11-04T10:00:00.000Z",
  data,
  organizationId: "org-1",
  url: String(data.url ?? ""),
  ...extra,
});

describe("normalizeLinear", () => {
  it("gives an issue newly assigned to the guardian, direct", async () => {
    const result = await normalizeLinear(
      UPDATED,
      hook(issue(), { updatedFrom: { assigneeId: null } }),
      ctx(),
    );
    expect(result).toEqual({
      keep: true,
      event: {
        id: "linear:u-me:issue:iss-1:assigned:u-me:2026-11-04T10:00:00.000Z",
        source: "linear",
        kind: "assigned_to_you",
        actor: "Bo Diaz",
        subject: "ENG-42 Checkout times out",
        url: "https://linear.app/acme/issue/ENG-42",
        excerpt: "Steps in the doc",
        byYou: false,
        addressedTo: "direct",
        labels: ["issue", "assigned", "team:eng", "urgent"],
      },
    });
  });

  it("gives a status change with the new state, direct on the guardian's issue", async () => {
    const result = await normalizeLinear(
      UPDATED,
      hook(issue(), { updatedFrom: { stateId: "st-1" } }),
      ctx(),
    );
    expect(result).toMatchObject({
      keep: true,
      event: {
        kind: "status_changed",
        excerpt: "Now In Progress.",
        addressedTo: "direct",
        labels: ["issue", "status-changed", "state:started", "team:eng", "urgent"],
      },
    });
    const watching = await normalizeLinear(
      UPDATED,
      hook(issue({ assigneeId: "u-bo", subscriberIds: ["u-me"] }), {
        updatedFrom: { stateId: "st-1" },
      }),
      ctx(),
    );
    expect(watching.keep && watching.event.addressedTo).toBe("copy");
  });

  it("drops a change follows do not describe, and keeps an unknown change when Linear names none", async () => {
    expect(
      await normalizeLinear(UPDATED, hook(issue(), { updatedFrom: { priority: 3 } }), ctx()),
    ).toEqual({ keep: false, reason: "a Linear change follows do not describe" });
    const unknown = await normalizeLinear(UPDATED, hook(issue()), ctx());
    expect(unknown).toMatchObject({
      keep: true,
      event: { kind: "status_changed", labels: ["issue", "updated", "team:eng", "urgent"] },
    });
  });

  it("gives a comment that mentions the guardian, and reads whose issue a bare comment is on", async () => {
    const comment = {
      id: "c-1",
      body: "Can @mia take a look?",
      issueId: "iss-1",
      issue: { id: "iss-1", identifier: "ENG-42", title: "Checkout times out" },
      userId: "u-bo",
      user: { id: "u-bo", name: "Bo Diaz" },
      url: "https://linear.app/acme/issue/ENG-42#comment-c-1",
      createdAt: "2026-11-04T10:00:00.000Z",
    };
    expect(await normalizeLinear(COMMENT, hook(comment, { action: "create" }), ctx())).toEqual({
      keep: true,
      event: {
        id: "linear:u-me:comment:c-1",
        source: "linear",
        kind: "comment_or_mention",
        actor: "Bo Diaz",
        subject: "ENG-42 Checkout times out",
        url: "https://linear.app/acme/issue/ENG-42#comment-c-1",
        excerpt: "Can @mia take a look?",
        byYou: false,
        addressedTo: "direct",
        labels: ["comment", "mention"],
      },
    });
    const onYours = await normalizeLinear(
      COMMENT,
      hook({ ...comment, body: "Shipped a fix", parentId: "c-0" }),
      ctx(ALL, { assigneeId: "u-me", subscriberIds: [] }),
    );
    expect(onYours).toMatchObject({
      keep: true,
      event: { addressedTo: "direct", labels: ["comment", "reply", "your-issue"] },
    });
  });

  it("keeps a new issue only when that kind is on, unless it is assigned to the guardian", async () => {
    const mine = await normalizeLinear(
      CREATED,
      hook(issue(), { action: "create" }),
      ctx(new Set(["assigned_to_you"])),
    );
    expect(mine.keep && mine.event.kind).toBe("assigned_to_you");
    const other = issue({ assigneeId: undefined });
    expect(await normalizeLinear(CREATED, hook(other), ctx(new Set(["assigned_to_you"])))).toEqual({
      keep: false,
      reason: "not a kind this follow has on",
    });
    const opened = await normalizeLinear(CREATED, hook(other), ctx());
    expect(opened).toMatchObject({
      keep: true,
      event: { kind: "new_issue", addressedTo: "other" },
    });
  });

  it("says the guardian did what they did", async () => {
    const result = await normalizeLinear(
      UPDATED,
      hook(issue(), {
        actor: { id: "u-me", name: "Mia Chen", type: "user" },
        updatedFrom: { stateId: "st-1" },
      }),
      ctx(),
    );
    expect(result.keep && result.event.byYou).toBe(true);
  });
});

describe("mentionsViewer", () => {
  it("finds an @name or a profile link, and not a longer name", () => {
    expect(mentionsViewer("ping @mia", viewer)).toBe(true);
    expect(mentionsViewer("see https://linear.app/acme/profiles/mia", viewer)).toBe(true);
    expect(mentionsViewer("ping @mia-bot", viewer)).toBe(false);
    expect(mentionsViewer("email mia@x.io", viewer)).toBe(false);
  });
});

describe("normalizeLinear when a read fails", () => {
  it("throws when whose issue a comment is on cannot be read, rather than saying it is no one's", async () => {
    const failing = {
      kinds: ALL,
      reads: {
        linearViewer: async () => viewer,
        linearIssue: async (): Promise<LinearIssuePeople> => {
          throw new Error("Linear answered 502");
        },
      },
    };
    const comment = { id: "c-9", body: "Done", issueId: "iss-1", issue: { id: "iss-1" } };
    await expect(normalizeLinear(COMMENT, hook(comment), failing)).rejects.toThrow("502");
  });
});

describe("normalizeLinear with assignments alone on", () => {
  it("keeps an unknown change to an issue assigned to the guardian, without claiming a new assignment", async () => {
    const result = await normalizeLinear(UPDATED, hook(issue()), ctx(new Set(["assigned_to_you"])));
    expect(result).toMatchObject({
      keep: true,
      event: {
        id: "linear:u-me:issue:iss-1:updated:2026-11-04T10:00:00.000Z",
        kind: "assigned_to_you",
        addressedTo: "direct",
        labels: ["issue", "updated", "assigned-to-you", "team:eng", "urgent"],
      },
    });
    expect(result.keep && result.event.labels).not.toContain("assigned");
    expect(
      await normalizeLinear(
        UPDATED,
        hook(issue({ assigneeId: "u-bo" })),
        ctx(new Set(["assigned_to_you"])),
      ),
    ).toMatchObject({ keep: false });
  });
});

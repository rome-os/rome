// Linear's public-team webhooks in the common shape. A payload is Linear's
// webhook body: the `actor`, the issue or comment as `data`, and, on an
// update, the previous values in `updatedFrom`.

import { drop, KIND_OFF, keep, obj, str } from "../../shared/event.js";
import type { AddressedTo, Json, Normalized } from "../../types.js";
import type { LinearIssuePeople, LinearReads, LinearViewer } from "./reads.js";

export interface LinearContext {
  kinds: ReadonlySet<string>;
  reads: LinearReads;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a comment mentions the viewer: `@name`, or a link to their profile. */
export function mentionsViewer(body: string | undefined, viewer: LinearViewer): boolean {
  if (!body) return false;
  return [viewer.displayName, viewer.name]
    .filter((name): name is string => Boolean(name))
    .some((name) =>
      new RegExp(
        `(^|[^\\w-])@${escape(name)}(?![\\w-])|/profiles/${escape(name)}(?![\\w-])`,
        "i",
      ).test(body),
    );
}

const personOf = (person: unknown) => {
  const p = obj(person);
  return str(p.name) ?? str(p.displayName) ?? str(p.email);
};

/** How an issue is addressed to the viewer: theirs when assigned to or created by them, a copy when they subscribe. */
function issueAddressed(people: LinearIssuePeople, viewerId: string): AddressedTo {
  if (people.assigneeId === viewerId || people.creatorId === viewerId) return "direct";
  return people.subscriberIds.includes(viewerId) ? "copy" : "other";
}

function issuePeople(issue: Json): LinearIssuePeople {
  const subscribers = Array.isArray(issue.subscriberIds) ? issue.subscriberIds : [];
  const assigneeId = str(issue.assigneeId) ?? str(obj(issue.assignee).id);
  const creatorId = str(issue.creatorId) ?? str(obj(issue.creator).id);
  return {
    ...(assigneeId ? { assigneeId } : {}),
    ...(creatorId ? { creatorId } : {}),
    subscriberIds: subscribers.filter((id): id is string => typeof id === "string"),
  };
}

/** A raw Linear event of `type` in the common shape, or why it is not one. */
export async function normalizeLinear(
  type: string,
  payload: Json,
  ctx: LinearContext,
): Promise<Normalized> {
  const data = obj(payload.data);
  const id = str(data.id);
  if (!id) return drop("no Linear id");
  const viewer = await ctx.reads.linearViewer();
  const me = viewer.id;
  const actor = obj(payload.actor);
  const actorId = str(actor.id) ?? str(data.userId) ?? str(obj(data.user).id);
  const byYou = actorId === me;
  const bot = str(actor.type) !== undefined && str(actor.type) !== "user";
  const at = str(data.updatedAt) ?? str(payload.createdAt) ?? "";

  if (type === "linear_public_team_comment_created") {
    if (!ctx.kinds.has("comment_or_mention")) return drop(KIND_OFF);
    const issue = obj(data.issue);
    const issueId = str(data.issueId) ?? str(issue.id);
    const body = str(data.body);
    const mentioned = mentionsViewer(body, viewer);
    // The comment names its issue but not always who the issue belongs to.
    let people = issuePeople(issue);
    if (!people.assigneeId && !people.creatorId && issueId) {
      people = await ctx.reads.linearIssue(issueId).catch(() => people);
    }
    const onYours = issueAddressed(people, me);
    return keep("linear", `${me}:comment:${id}`, "comment_or_mention", {
      actor: personOf(data.user) ?? personOf(actor),
      subject: [str(issue.identifier), str(issue.title)].filter(Boolean).join(" ") || undefined,
      url: str(data.url) ?? str(payload.url),
      text: body,
      byYou,
      addressedTo: mentioned ? "direct" : onYours,
      labels: [
        "comment",
        mentioned && "mention",
        str(data.parentId) && "reply",
        onYours === "direct" && "your-issue",
        bot && "bot",
      ],
    });
  }

  const people = issuePeople(data);
  const shared = {
    actor: personOf(actor),
    subject: [str(data.identifier), str(data.title)].filter(Boolean).join(" ") || undefined,
    url: str(data.url) ?? str(payload.url),
    byYou,
  };
  const state = obj(data.state);
  const team = str(obj(data.team).key);
  const facts = [
    team && `team:${team.toLowerCase()}`,
    bot && "bot",
    str(data.priorityLabel)?.toLowerCase() === "urgent" && "urgent",
  ];

  if (type === "linear_public_team_issue_created") {
    if (people.assigneeId === me && ctx.kinds.has("assigned_to_you")) {
      return keep("linear", `${me}:issue:${id}:assigned:${me}:${at}`, "assigned_to_you", {
        ...shared,
        text: str(data.description),
        addressedTo: "direct",
        labels: ["issue", "assigned", "opened", ...facts],
      });
    }
    if (!ctx.kinds.has("new_issue")) return drop(KIND_OFF);
    return keep("linear", `${me}:issue:${id}:opened`, "new_issue", {
      ...shared,
      text: str(data.description),
      addressedTo: mentionsViewer(str(data.description), viewer)
        ? "direct"
        : issueAddressed(people, me),
      labels: ["issue", "opened", ...facts],
    });
  }

  if (type === "linear_public_team_issue_properties_updated") {
    const before = obj(payload.updatedFrom);
    const assignedNow = "assigneeId" in before && people.assigneeId === me;
    if (assignedNow && ctx.kinds.has("assigned_to_you")) {
      return keep("linear", `${me}:issue:${id}:assigned:${me}:${at}`, "assigned_to_you", {
        ...shared,
        text: str(data.description),
        addressedTo: "direct",
        labels: ["issue", "assigned", ...facts],
      });
    }
    if ("stateId" in before && ctx.kinds.has("status_changed")) {
      const stateType = str(state.type)?.toLowerCase();
      return keep(
        "linear",
        `${me}:issue:${id}:state:${str(data.stateId) ?? ""}:${at}`,
        "status_changed",
        {
          ...shared,
          text: str(state.name) ? `Now ${str(state.name)}.` : undefined,
          addressedTo: issueAddressed(people, me),
          labels: [
            "issue",
            "status-changed",
            stateType && /^[a-z]+$/.test(stateType) && `state:${stateType}`,
            ...facts,
          ],
        },
      );
    }
    // Without `updatedFrom` the change is not known, so it reaches triage as one.
    if (!("updatedFrom" in payload) && ctx.kinds.has("status_changed")) {
      return keep("linear", `${me}:issue:${id}:updated:${at}`, "status_changed", {
        ...shared,
        text: str(state.name) ? `Status ${str(state.name)}.` : undefined,
        addressedTo: issueAddressed(people, me),
        labels: ["issue", "updated", ...facts],
      });
    }
    return drop(
      assignedNow || "stateId" in before ? KIND_OFF : "a Linear change follows do not describe",
    );
  }
  return drop(`Linear ${type} is not a kind follows describe`);
}

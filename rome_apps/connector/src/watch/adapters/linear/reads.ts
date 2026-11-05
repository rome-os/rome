// What the Linear normalizer reads: the connected user, and who an issue
// belongs to when a comment names only the issue. Live reads go through the
// connected account; tests inject their own.

import { identityOf, record, required, text } from "../../shared/composio.js";
import type { ComposioToolkit, WatchEnv } from "../../types.js";

/** The connected Linear user. */
export interface LinearViewer {
  id: string;
  name?: string;
  displayName?: string;
  email?: string;
}

/** Who a Linear issue belongs to. */
export interface LinearIssuePeople {
  assigneeId?: string;
  creatorId?: string;
  subscriberIds: string[];
}

export interface LinearReads {
  linearViewer(): Promise<LinearViewer>;
  linearIssue(id: string): Promise<LinearIssuePeople>;
}

export function linearReads(env: WatchEnv, service: ComposioToolkit): LinearReads {
  /** Linear answers GraphQL errors with a 200, so the errors are read here. */
  const query = async (q: string, variables: Record<string, unknown> = {}) => {
    const res = await env.composio.read(service, {
      endpoint: "https://api.linear.app/graphql",
      method: "POST",
      body: { query: q, variables },
    });
    const errors = Array.isArray(res.errors) ? res.errors : [];
    if (errors.length > 0) {
      throw new Error(`Linear answered: ${text(record(errors[0]).message) ?? "an error"}`);
    }
    return record(res.data);
  };
  return {
    linearViewer: () =>
      identityOf(env, service, async () => {
        const viewer = record(
          (await query("query { viewer { id name displayName email } }")).viewer,
        );
        return {
          id: required(service, text(viewer.id)),
          ...(text(viewer.name) ? { name: text(viewer.name) } : {}),
          ...(text(viewer.displayName) ? { displayName: text(viewer.displayName) } : {}),
          ...(text(viewer.email) ? { email: text(viewer.email)?.toLowerCase() } : {}),
        };
      }),
    async linearIssue(id) {
      const issue = record(
        (
          await query(
            "query ($id: String!) { issue(id: $id) { assignee { id } creator { id } subscribers { nodes { id } } } }",
            { id },
          )
        ).issue,
      );
      const nodes = record(issue.subscribers).nodes;
      return {
        ...(text(record(issue.assignee).id) ? { assigneeId: text(record(issue.assignee).id) } : {}),
        ...(text(record(issue.creator).id) ? { creatorId: text(record(issue.creator).id) } : {}),
        subscriberIds: (Array.isArray(nodes) ? nodes : [])
          .map((node) => text(record(node).id))
          .filter((nodeId): nodeId is string => nodeId !== undefined),
      };
    },
  };
}

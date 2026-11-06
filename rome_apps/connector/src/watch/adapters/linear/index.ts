// Linear: the public-team webhooks, which fire workspace-wide when no team is
// set. Private teams have only polling triggers that each name one team.

import { composioAdapter, fromComposio } from "../../shared/composio.js";
import type { ComposioTriggerSpec, Watchable } from "../../types.js";
import { normalizeLinear } from "./normalize.js";
import { linearReads } from "./reads.js";

const linear = (slug: string): ComposioTriggerSpec => ({
  toolkit: "linear",
  slug,
  config: {},
  unscoped: ["team_id"],
});
export const LINEAR_ISSUE_CREATED = linear("LINEAR_PUBLIC_TEAM_ISSUE_CREATED");
export const LINEAR_ISSUE_UPDATED = linear("LINEAR_PUBLIC_TEAM_ISSUE_PROPERTIES_UPDATED");
export const LINEAR_COMMENT_CREATED = linear("LINEAR_PUBLIC_TEAM_COMMENT_CREATED");

export const LINEAR_WATCHABLE: Watchable = {
  source: "linear",
  label: "Linear",
  target: null,
  kinds: [
    {
      kind: "assigned_to_you",
      label: "Issues assigned to me",
      default: true,
      triggers: [fromComposio(LINEAR_ISSUE_CREATED), fromComposio(LINEAR_ISSUE_UPDATED)],
    },
    {
      kind: "comment_or_mention",
      label: "Comments on my issues, and mentions",
      default: true,
      triggers: [fromComposio(LINEAR_COMMENT_CREATED)],
    },
    {
      kind: "status_changed",
      label: "Status changes on my issues",
      default: true,
      triggers: [fromComposio(LINEAR_ISSUE_UPDATED)],
    },
    {
      kind: "new_issue",
      label: "New issues in my teams",
      default: false,
      triggers: [fromComposio(LINEAR_ISSUE_CREATED)],
    },
  ],
  options: [
    {
      key: "teams",
      label: "Teams to hear about",
      type: "list",
      default: [],
      itemHint: "Team keys such as ENG; empty means every team",
    },
  ],
};

export const linearAdapter = composioAdapter({
  catalog: LINEAR_WATCHABLE,
  triggers: [LINEAR_ISSUE_CREATED, LINEAR_ISSUE_UPDATED, LINEAR_COMMENT_CREATED],
  async account(env, service) {
    const viewer = await linearReads(env, service).linearViewer();
    return viewer.email ?? viewer.name ?? viewer.id;
  },
  normalize: (env, { type, payload, kinds, service }) =>
    normalizeLinear(type, payload, {
      kinds,
      reads: linearReads(env, service),
    }),
});

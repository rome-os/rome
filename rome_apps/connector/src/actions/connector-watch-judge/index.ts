import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { PROVIDER_EVENT_PREFIX } from "../../api/topic.js";
import { judgeGithub, judgeGmail } from "../../watch/judge.js";
import { isTeamMember } from "../../watch/runtime.js";

const GITHUB_PREFIX = `${PROVIDER_EVENT_PREFIX}github.`;

const inputSchema = z.object({
  source: z.string(),
  eventName: z.string(),
  payload: z.record(z.string(), z.unknown()),
  account: z.string().min(1),
  kinds: z.array(z.string()),
  options: z.record(z.string(), z.unknown()).optional(),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ source, eventName, payload, account, kinds, options }) => {
      if (source === "github" && eventName.startsWith(GITHUB_PREFIX)) {
        return {
          status: "ok",
          data: await judgeGithub(eventName.slice(GITHUB_PREFIX.length), payload, {
            login: account,
            kinds: new Set(kinds),
            ...(options ? { options } : {}),
            isTeamMember: (org, slug) => isTeamMember(org, slug, account),
          }),
        };
      }
      if (source === "gmail") {
        if (!kinds.includes("new_mail")) {
          return {
            status: "ok",
            data: { relevant: false, reason: "not a kind the follow has on" },
          };
        }
        return {
          status: "ok",
          data: judgeGmail(payload, { address: account, ...(options ? { options } : {}) }),
        };
      }
      return { status: "error", error: `Rome cannot judge ${eventName} for "${source}".` };
    },
  });
}

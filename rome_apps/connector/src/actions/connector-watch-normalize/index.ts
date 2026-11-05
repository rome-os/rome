import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { PROVIDER_EVENT_PREFIX } from "../../api/topic.js";
import { normalizeCalendar, normalizeGithub, normalizeGmail } from "../../watch/normalize.js";
import { isTeamMember } from "../../watch/runtime.js";

const GITHUB_PREFIX = `${PROVIDER_EVENT_PREFIX}github.`;
const CALENDAR_PREFIX = `${PROVIDER_EVENT_PREFIX}googlecalendar.`;

const inputSchema = z.object({
  source: z.string(),
  eventName: z.string(),
  payload: z.record(z.string(), z.unknown()),
  account: z.string().min(1),
  kinds: z.array(z.string()),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ source, eventName, payload, account, kinds }) => {
      if (source === "github" && eventName.startsWith(GITHUB_PREFIX)) {
        return {
          status: "ok",
          data: await normalizeGithub(eventName.slice(GITHUB_PREFIX.length), payload, {
            login: account,
            kinds: new Set(kinds),
            isTeamMember: (org, slug) => isTeamMember(org, slug, account),
          }),
        };
      }
      if (source === "gmail") {
        if (!kinds.includes("new_mail")) {
          return { status: "ok", data: { keep: false, reason: "not a kind this follow has on" } };
        }
        return { status: "ok", data: normalizeGmail(payload, { address: account }) };
      }
      if (source === "googlecalendar" && eventName.startsWith(CALENDAR_PREFIX)) {
        return {
          status: "ok",
          data: normalizeCalendar(eventName.slice(CALENDAR_PREFIX.length), payload, {
            address: account,
            kinds: new Set(kinds),
          }),
        };
      }
      return { status: "error", error: `Rome cannot read ${eventName} for "${source}".` };
    },
  });
}

import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { PROVIDER_EVENT_PREFIX } from "../../api/topic.js";
import { normalizeCalendar, normalizeGithub, normalizeGmail } from "../../watch/normalize.js";
import { normalizeLinear } from "../../watch/normalize-linear.js";
import { normalizeNotion } from "../../watch/normalize-notion.js";
import { normalizeOutlook } from "../../watch/normalize-outlook.js";
import { normalizeStripe } from "../../watch/normalize-stripe.js";
import { isTeamMember, watchReads } from "../../watch/runtime.js";

const GITHUB_PREFIX = `${PROVIDER_EVENT_PREFIX}github.`;

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
      // Every Composio event is named `<toolkit>.<trigger slug>`.
      const prefix = `${PROVIDER_EVENT_PREFIX}${source}.`;
      const type = eventName.startsWith(prefix) ? eventName.slice(prefix.length) : undefined;
      const on = new Set(kinds);
      try {
        const data =
          type === undefined
            ? undefined
            : source === "googlecalendar"
              ? normalizeCalendar(type, payload, { address: account, kinds: on })
              : source === "linear"
                ? await normalizeLinear(type, payload, { kinds: on, reads: watchReads })
                : source === "outlook"
                  ? await normalizeOutlook(payload, {
                      address: account,
                      kinds: on,
                      reads: watchReads,
                    })
                  : source === "notion"
                    ? await normalizeNotion(type, payload, { kinds: on, reads: watchReads })
                    : source === "stripe"
                      ? normalizeStripe(type, payload, { account, kinds: on })
                      : undefined;
        if (data) return { status: "ok", data };
      } catch (error) {
        // A read the event needed failed: the follower tries it again.
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      return { status: "error", error: `Rome cannot read ${eventName} for "${source}".` };
    },
  });
}

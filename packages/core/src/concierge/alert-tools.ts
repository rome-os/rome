// The Concierge's tools for its alert subscriptions (alert-events.ts).

import type { FacadeToolDef } from "../core/mcp-facade.js";
import { runFacadeTool } from "../core/mcp-facade.js";
import {
  CONCIERGE_ALERT_MAX_SPACING_MINUTES,
  CONCIERGE_ALERT_MAX_TURNS_PER_HOUR,
} from "@rome/api-types/concierge";
import { validateRulesChange } from "./alert-events.js";
import type { ConciergeService } from "./service.js";

export function buildAlertTools(service: ConciergeService): FacadeToolDef[] {
  return [
    {
      name: "alerts_watch",
      description:
        "Start telling the guardian about GitHub events in a repo that concern them: a review requested of them, a review or comment on their PR or issue, an @mention, a CI run of theirs that failed. " +
        "Use it when the guardian asks to hear about a repo. Events then arrive as <external_events> batches. Calling it again for a watched repo is harmless. " +
        "Their GitHub login is read off their connected GitHub account; pass login only when the result asks for it.",
      inputSchema: {
        type: "object",
        required: ["repo"],
        properties: {
          repo: { type: "string", description: "owner/name, spelled as GitHub spells it." },
          login: {
            type: "string",
            description:
              "The guardian's GitHub username, only when no GitHub account is connected.",
          },
        },
      },
      handler: (input) =>
        runFacadeTool("alerts_watch", input, async (args) =>
          service.alerts.watch({
            repo: String(args.repo ?? ""),
            ...(typeof args.login === "string" ? { login: args.login } : {}),
          }),
        ),
    },
    {
      name: "alerts_unwatch",
      description: "Stop telling the guardian about GitHub events in a repo.",
      inputSchema: {
        type: "object",
        required: ["repo"],
        properties: { repo: { type: "string", description: "owner/name" } },
      },
      handler: (input) =>
        runFacadeTool("alerts_unwatch", input, async (args) =>
          service.alerts.unwatch(String(args.repo ?? "")),
        ),
    },
    {
      name: "alerts_list",
      description:
        "List the repos you watch for the guardian, with each event kind on or off, and the alert rules (rate limit, quiet hours).",
      inputSchema: { type: "object", properties: {} },
      handler: (input) =>
        runFacadeTool("alerts_list", input, async () => ({
          watching: await service.alerts.list(),
          rules: await service.alerts.rules(),
        })),
    },
    {
      name: "alerts_configure",
      description:
        "Change the alert rules when the guardian asks. Fields you leave out stay. " +
        "quietHours is a daily window in their own timezone: events then wait and arrive as one batch when it ends; null turns it off. " +
        "maxTurnsPerHour and minSpacingMinutes bound how often alerts may reach you.",
      inputSchema: {
        type: "object",
        properties: {
          quietHours: {
            type: ["object", "null"],
            required: ["start", "end"],
            properties: {
              start: { type: "string", description: "HH:mm, 24-hour, e.g. 22:00" },
              end: { type: "string", description: "HH:mm, 24-hour, e.g. 08:00" },
            },
          },
          maxTurnsPerHour: {
            type: "integer",
            minimum: 1,
            maximum: CONCIERGE_ALERT_MAX_TURNS_PER_HOUR,
          },
          minSpacingMinutes: {
            type: "integer",
            minimum: 0,
            maximum: CONCIERGE_ALERT_MAX_SPACING_MINUTES,
          },
        },
      },
      handler: (input) =>
        runFacadeTool("alerts_configure", input, async (args) =>
          service.alerts.setRules(validateRulesChange(args)),
        ),
    },
  ];
}

// The Concierge's tools for its alert subscriptions (alert-events.ts).

import type { FacadeToolDef } from "../core/mcp-facade.js";
import { runFacadeTool } from "../core/mcp-facade.js";
import { parseQuietHours } from "./alerts.js";
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
      description: "List the repos you watch for the guardian, and the quiet hours.",
      inputSchema: { type: "object", properties: {} },
      handler: (input) =>
        runFacadeTool("alerts_list", input, async () => ({
          watching: await service.alerts.list(),
          ...(await service.alerts.settings()),
        })),
    },
    {
      name: "alerts_configure",
      description:
        "Set the guardian's quiet hours for alerts, in their own timezone. Events during quiet hours wait and arrive as one batch when they end. Pass null to turn quiet hours off.",
      inputSchema: {
        type: "object",
        required: ["quietHours"],
        properties: {
          quietHours: {
            type: ["object", "null"],
            required: ["start", "end"],
            properties: {
              start: { type: "string", description: "HH:mm, 24-hour, e.g. 22:00" },
              end: { type: "string", description: "HH:mm, 24-hour, e.g. 08:00" },
            },
          },
        },
      },
      handler: (input) =>
        runFacadeTool("alerts_configure", input, async (args) => {
          if (args.quietHours === null) return service.alerts.configure({ quietHours: null });
          const quietHours = parseQuietHours(args.quietHours);
          if (!quietHours) {
            throw new Error("quietHours needs start and end as different HH:mm times, or null");
          }
          return service.alerts.configure({ quietHours });
        }),
    },
  ];
}

// The Concierge's tools for what it follows (following.ts): one follow tool per
// source, and list, unfollow and configure for every source.

import {
  CONCIERGE_FOLLOW_MAX_SPACING_MINUTES,
  CONCIERGE_FOLLOW_MAX_TURNS_PER_HOUR,
  CONCIERGE_FOLLOW_SOURCES,
} from "@rome/api-types/concierge";
import type { FacadeToolDef } from "../core/mcp-facade.js";
import { runFacadeTool } from "../core/mcp-facade.js";
import { isFollowSource, validateRulesChange } from "./following.js";
import type { ConciergeService } from "./service.js";

export function buildFollowingTools(service: ConciergeService): FacadeToolDef[] {
  return [
    {
      name: "follow_github_repo",
      description:
        "Follow a GitHub repo for the guardian: hear about events there that concern them, such as a review requested of them, a review or comment on their PR or issue, an @mention, or a CI run of theirs that failed. " +
        "Events then arrive as <external_events> batches. Following a repo again is harmless. " +
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
        runFacadeTool("follow_github_repo", input, async (args) =>
          service.following.followGithubRepo({
            repo: String(args.repo ?? ""),
            ...(typeof args.login === "string" ? { login: args.login } : {}),
          }),
        ),
    },
    {
      name: "follow_gmail",
      description:
        "Follow the guardian's connected Gmail inbox: hear about new mail from people. Bulk, automated and promotional mail is dropped before you see it. " +
        "Events then arrive as <external_events> batches. Following it again is harmless.",
      inputSchema: { type: "object", properties: {} },
      handler: (input) =>
        runFacadeTool("follow_gmail", input, async () => service.following.followGmail()),
    },
    {
      name: "following_list",
      description:
        "List what you follow for the guardian, by source, with each kind of event on or off, and the rules (rate limit, quiet hours).",
      inputSchema: { type: "object", properties: {} },
      handler: (input) =>
        runFacadeTool("following_list", input, async () => ({
          following: await service.following.list(),
          rules: await service.following.rules(),
        })),
    },
    {
      name: "unfollow",
      description:
        "Stop following something for the guardian. Take source and target from following_list.",
      inputSchema: {
        type: "object",
        required: ["source", "target"],
        properties: {
          source: { type: "string", enum: [...CONCIERGE_FOLLOW_SOURCES] },
          target: { type: "string", description: "owner/name for GitHub, the address for Gmail." },
        },
      },
      handler: (input) =>
        runFacadeTool("unfollow", input, async (args) => {
          if (!isFollowSource(args.source)) {
            throw new Error(`source must be one of: ${CONCIERGE_FOLLOW_SOURCES.join(", ")}`);
          }
          return service.following.unfollow(args.source, String(args.target ?? ""));
        }),
    },
    {
      name: "following_configure",
      description:
        "Change the rules for what you follow when the guardian asks. They hold for every source. Fields you leave out stay. " +
        "quietHours is a daily window in their own timezone: events then wait and arrive as one batch when it ends; null turns it off. " +
        "maxTurnsPerHour and minSpacingMinutes bound how often these events may reach you.",
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
            maximum: CONCIERGE_FOLLOW_MAX_TURNS_PER_HOUR,
          },
          minSpacingMinutes: {
            type: "integer",
            minimum: 0,
            maximum: CONCIERGE_FOLLOW_MAX_SPACING_MINUTES,
          },
        },
      },
      handler: (input) =>
        runFacadeTool("following_configure", input, async (args) =>
          service.following.setRules(validateRulesChange(args)),
        ),
    },
  ];
}

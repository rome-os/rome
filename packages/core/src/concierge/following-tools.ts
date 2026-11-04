// The Concierge's tools for what it follows (following.ts). They name no
// source: what each source needs and which kinds it has come back in
// `following_list`, so a new source changes no tool definition.

import {
  CONCIERGE_FOLLOW_MAX_SPACING_MINUTES,
  CONCIERGE_FOLLOW_MAX_TURNS_PER_HOUR,
} from "@rome/api-types/concierge";
import type { FacadeToolDef } from "../core/mcp-facade.js";
import { runFacadeTool } from "../core/mcp-facade.js";
import { FOLLOW_SOURCE_INFO, isFollowSource, validateRulesChange } from "./following.js";
import type { ConciergeService } from "./service.js";

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function buildFollowingTools(service: ConciergeService): FacadeToolDef[] {
  return [
    {
      name: "follow",
      description:
        "Follow something for the guardian, such as a code repo or their inbox, and hear about its events that concern them. " +
        "Events then arrive as <external_events> batches. Following the same thing again is harmless. " +
        "When unsure which sources exist or what one needs as target and options, check following_list first.",
      inputSchema: {
        type: "object",
        required: ["source"],
        properties: {
          source: { type: "string", description: "Where it lives, as following_list names it." },
          target: {
            type: "string",
            description: "What to follow there, in the source's format. Some sources take none.",
          },
          options: {
            type: "object",
            description: "Inputs the source asks for, by name. Usually none.",
          },
        },
      },
      handler: (input) =>
        runFacadeTool("follow", input, async (args) => {
          const target = optionalString(args.target);
          const options =
            args.options && typeof args.options === "object" && !Array.isArray(args.options)
              ? (args.options as Record<string, unknown>)
              : undefined;
          return service.following.follow({
            source: String(args.source ?? "").trim(),
            ...(target ? { target } : {}),
            ...(options ? { options } : {}),
          });
        }),
    },
    {
      name: "following_list",
      description:
        "List what you follow for the guardian, with each kind of event on or off, the rules (rate limit, quiet hours), and the sources you can follow with what each needs.",
      inputSchema: { type: "object", properties: {} },
      handler: (input) =>
        runFacadeTool("following_list", input, async () => ({
          following: await service.following.list(),
          rules: await service.following.rules(),
          sources: FOLLOW_SOURCE_INFO,
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
          source: { type: "string" },
          target: { type: "string" },
        },
      },
      handler: (input) =>
        runFacadeTool("unfollow", input, async (args) => {
          const source = String(args.source ?? "").trim();
          if (!isFollowSource(source)) {
            throw new Error(
              `Rome follows nothing at "${source}". Supported sources: ${FOLLOW_SOURCE_INFO.map((info) => info.source).join(", ")}.`,
            );
          }
          return service.following.unfollow(source, String(args.target ?? ""));
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

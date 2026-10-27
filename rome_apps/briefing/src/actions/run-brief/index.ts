import { createAppLogger } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { createBriefsRepository, type Brief } from "../../db/repositories/briefs.js";
import {
  createScoutResultsRepository,
  type ScoutResult,
} from "../../db/repositories/scout-results.js";
import { createSettingsRepository, type BriefingSettings } from "../../db/repositories/settings.js";
import { isSupportedChannel, channelSetupHint } from "../../lib/channels.js";
import { unwrap, summonText } from "../../lib/action-result.js";
import { gatherGuardianContext, type GuardianContext } from "../../lib/guardian-context.js";

const log = createAppLogger("briefing_run_brief");

interface RunBriefInput {
  kind?: string;
  deliver?: boolean;
}

function nowLabel(tz: string): { date: string; time: string } {
  const d = new Date();
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return { date, time };
}

function describeScoutResults(results: ScoutResult[]): string {
  if (results.length === 0) return "(No new scouting findings since the last brief.)";
  return results
    .map((r) => `### ${r.scoutTitle}\n${(r.content ?? "").trim() || "(no findings)"}`)
    .join("\n\n");
}

const SUGGESTIONS_HEADER = "**Try with Rome**";

/** Where the "Try with Rome" section starts and ends: up to the next bold header line. */
function suggestionsBounds(content: string): { start: number; body: number; end: number } | null {
  const start = content.indexOf(SUGGESTIONS_HEADER);
  if (start < 0) return null;
  const body = start + SUGGESTIONS_HEADER.length;
  const next = content.slice(body).search(/\n\*\*[^*\n]+\*\*\s*\n/);
  return { start, body, end: next < 0 ? content.length : body + next + 1 };
}

/** The "Try with Rome" section of a stored brief, so the next one does not repeat it. */
export function suggestionsSection(content: string | null | undefined): string | null {
  const bounds = content ? suggestionsBounds(content) : null;
  if (!content || !bounds) return null;
  return content.slice(bounds.body, bounds.end).trim() || null;
}

/** A brief without its "Try with Rome" section, which carries personal context. */
export function withoutSuggestions(content: string): string {
  const bounds = suggestionsBounds(content);
  if (!bounds) return content;
  return (content.slice(0, bounds.start) + content.slice(bounds.end)).trim();
}

/** Scheduled briefs from the past day that the guardian already received, oldest first. */
export function previousDayBriefs(recent: Brief[], now: Date): Brief[] {
  // A little over a day, so yesterday's brief of the same kind still counts.
  const since = now.getTime() - 26 * 60 * 60 * 1000;
  return recent
    .filter(
      (b) =>
        b.kind !== "test" &&
        b.status === "completed" &&
        b.content?.trim() &&
        b.startedAt.getTime() >= since,
    )
    .reverse();
}

function previousBriefsInstructions(
  previous: Brief[],
  tz: string,
  includeSuggestions: boolean,
): string[] {
  if (previous.length === 0) return [];
  const label = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  return [
    "CONTINUITY — the guardian already received the briefs below from the past day. Use them to follow through and to avoid repeating yourself:",
    "   - Do not repeat anything those briefs already covered unless it changed or still needs action.",
    "   - Raise each Action Item once. If any brief below already listed it and the guardian has not acted on it, assume they saw it and chose not to: leave it out rather than reminding them. Bring it back only when something new happened, such as a fresh follow-up from the person or a deadline that is now due.",
    "   - Point out what changed since then, such as a moved meeting or a new reply in a thread.",
    "",
    "--- PREVIOUS BRIEFS (past day, oldest first) ---",
    ...previous.map((b) => {
      const content = (b.content ?? "").trim();
      return `### ${b.kind[0].toUpperCase()}${b.kind.slice(1)} brief — ${label(b.startedAt)}\n${
        includeSuggestions ? content : withoutSuggestions(content)
      }`;
    }),
    "",
  ];
}

/** Briefs that leave the guardian's hands carry no personal context. */
export function deliversToGuardian(settings: BriefingSettings, shouldDeliver: boolean): boolean {
  if (!shouldDeliver) return true;
  if (settings.channel === "email") {
    return ["", "guardian"].includes(settings.emailTo.trim().toLowerCase());
  }
  return settings.channel === "whatsapp" && !settings.whatsappThreadId.trim();
}

function suggestionsInstructions(context: GuardianContext | null, previous: string[]): string[] {
  if (!context || (!context.chats && !context.profile)) return [];
  return [
    "4. TRY WITH ROME — optional, under a **Try with Rome** header. Be proactive. Given how this guardian uses Rome and what they care about, propose what Rome could do to make their life better: help with their work, grow something they run, or bring more fun to something they enjoy. Offer at most two ideas, each specific to them. Leave the section out rather than offer a generic idea.",
    "   - Look at the whole person, not only their recent requests. Their chats and profile may show a business they run, a website or product they maintain, a goal they named, or a hobby or interest. Ask what Rome could build or do for each. For a business: a landing page, a customer email workflow, a weekly numbers digest. For a website: a redesign, a new feature, an SEO or broken-link check. For a hobby: a small game, a tracker, a guide, or a watcher for news and events about it. Also notice tasks they keep doing by hand in chat, and offer to automate them.",
    "   - Go beyond what they asked for. Suggest things they may not know Rome can do. Pick the ideas with the biggest payoff for them: time saved, a goal moved forward, or real enjoyment.",
    "   - Base each idea on evidence in the context: something they asked or did in a recent chat, or a project, goal or interest in their profile. Do not guess at their personality, mood, tastes or private life.",
    "   - Rome must be able to do it today: with an installed app, action, skill or connectable toolkit, or by building an app, website, game, routine or workflow. Check rather than assume, and never promise access to a service Rome cannot connect to. Skip anything an existing app, routine or workflow already does for them.",
    "   - Do not repeat or reword a suggestion from a recent brief (listed below).",
    "   - Write each idea in one or two sentences: the project, interest or need it connects to, what Rome would do or build and what that gives them, then a request they can send as is. E.g. 'Your bakery's website has no way to take orders. Rome could add a pre-order form that emails you each order — try: \"Add a pre-order form to my bakery website that emails me each order\"', or 'You've been planning hikes around Tahoe. Rome could send you a trail and weather pick every Friday — try: \"Every Friday, suggest a Tahoe hike for the weekend based on the forecast\"'. Never write 'you'd love', 'you probably want', 'as a <role>', or any other guess about who they are.",
    "   - Privacy: this context is private to the guardian. Refer to a chat only by its topic; do not quote it at length or mention other people named in it. Name the project or interest an idea is for, but do not recite their profile, employer or background back to them. Use extra caution with sensitive personal topics such as health, money, relationships or legal matters: do not suggest them unless the guardian has shown interest in them.",
    "   - Only suggest. Do not run, create, install or schedule anything.",
    "   - Use the context below only for this section; the other sections come from their own sources.",
    "",
    "--- HOW THE GUARDIAN USES ROME: THEIR RECENT WEBCHAT MESSAGES (their own words, last 48 hours) ---",
    context.chats ?? "(none)",
    "",
    "--- WHAT THE GUARDIAN CARES ABOUT: THEIR PUBLIC PROFILE ---",
    context.profile ?? "(not available)",
    "",
    "--- SUGGESTIONS IN RECENT BRIEFS (do not repeat) ---",
    previous.length > 0 ? previous.join("\n\n") : "(none)",
  ];
}

export function buildPrompt(
  kind: string,
  tz: string,
  results: ScoutResult[],
  context: GuardianContext | null,
  previousSuggestions: string[],
  previousBriefs: Brief[] = [],
  isFirstBrief = false,
): string {
  const { date, time } = nowLabel(tz);
  const isMorning = kind === "morning";
  const windowHint = isMorning
    ? "Focus on what matters for the day ahead: today's calendar events, anything overnight that needs a reply, and what to prioritize."
    : "Focus on wrapping up the day: what happened, anything still needing a response tonight, and what's on tomorrow's calendar.";
  return [
    `You are preparing the guardian's ${kind === "test" ? "briefing (test run)" : `${kind} brief`}.`,
    `Local date: ${date}. Local time: ${time} (${tz}).`,
    "",
    "Assemble a concise, well-structured briefing in markdown. Gather from these sources, using whatever tools and actions you have:",
    "",
    "1. CALENDAR — check the guardian's Google Calendar for relevant events (today, and tomorrow morning for an evening brief).",
    "2. MESSAGES — check recent messages on connected channels: WhatsApp (use fetch_channel_history with platform: whatsapp) and email (Gmail). Surface only what needs the guardian's attention; skip spam, marketing, newsletters and automated notifications, even when they ask for a reply. Summarize, don't dump.",
    "3. SCOUTING FINDINGS — the findings below were already gathered by scheduled scouting tasks. Integrate the key points.",
    ...suggestionsInstructions(context, previousSuggestions),
    "",
    `ROBUSTNESS: Some sources may not be connected. ${
      isFirstBrief
        ? "This is the guardian's first brief, so note each source that is not connected once, in one line like '_Calendar not connected._'"
        : "The guardian may have chosen not to connect them, so leave a source that is not connected out entirely, with no section or note."
    } If a connected source errors or has nothing relevant, skip it gracefully with a one-line note like '_Gmail could not be reached._' NEVER fail or refuse the whole brief because one source is missing.`,
    "",
    windowHint,
    "",
    ...previousBriefsInstructions(previousBriefs, tz, context !== null),
    "ACTION ITEMS — the guardian reads this list as what they must do. Each item costs their attention, and padding teaches them to skip the list, so include only what clearly matters to them:",
    "   - Include: a reply a real person is waiting on (someone writing to them personally, not a bulk or automated sender), a deadline, a decision only they can make, or preparation for an important event.",
    "   - Exclude: spam, marketing, promotions, newsletters, unsolicited pitches and automated notifications, even when they ask for a reply or claim urgency. Also exclude low-stakes chores, FYIs, and anything they appear to be ignoring on purpose (e.g. repeated follow-ups from a sender they never answer).",
    "   - Use judgment on borderline cases. If something is worth knowing but not worth acting on, mention it under Messages instead. An automated message occasionally does matter (a failed payment, a flight change); keep those.",
    "   - Fewer is better: one concrete action per bullet, most urgent first. If nothing qualifies, write '_Nothing urgent._'",
    "",
    "FORMAT: Start with a one-line summary of the most important items. Then short sections, each with a bold header on its own line, ordered by what matters most. Keep it skimmable and tight. Return ONLY the briefing markdown.",
    "",
    "--- SCOUTING FINDINGS SINCE LAST BRIEF ---",
    describeScoutResults(results),
  ].join("\n");
}

function fallbackBrief(kind: string, tz: string, results: ScoutResult[]): string {
  const { date } = nowLabel(tz);
  const heading =
    kind === "test" ? "Briefing (test)" : `${kind[0].toUpperCase()}${kind.slice(1)} brief`;
  const lines = [`**${heading}** — ${date}`, ""];
  if (results.length > 0) {
    lines.push("**Scouting**", "", describeScoutResults(results));
  } else {
    lines.push("_No new scouting findings, and live sources could not be reached for this brief._");
  }
  return lines.join("\n");
}

async function deliver(
  appContext: AppActionRuntimeDeps["appContext"],
  settings: BriefingSettings,
  kind: string,
  content: string,
): Promise<{ delivered: boolean; channel: string; deliveryError?: string }> {
  const channel = settings.channel;
  if (!isSupportedChannel(channel)) {
    return {
      delivered: false,
      channel,
      deliveryError: `Unsupported delivery channel "${channel}". ${channelSetupHint(channel)}`,
    };
  }

  const { date } = nowLabel(settings.timezone || "UTC");
  const subject =
    kind === "test"
      ? `Briefing test — ${date}`
      : `${kind[0].toUpperCase()}${kind.slice(1)} brief — ${date}`;

  let args: Record<string, unknown>;
  if (channel === "whatsapp") {
    // Prefer the platform's guardian resolution (to: "guardian"), which maps to
    // the guardian's WhatsApp chat automatically. An explicitly configured chat
    // id still overrides it for sending to a non-guardian thread.
    const explicitThread = settings.whatsappThreadId.trim();
    args = explicitThread
      ? { platform: "whatsapp", threadId: explicitThread, text: content }
      : { platform: "whatsapp", to: "guardian", text: content };
  } else {
    args = {
      platform: "email",
      to: settings.emailTo.trim() || "guardian",
      subject,
      text: content,
    };
  }

  try {
    const res = unwrap(await appContext.runAction("send_message", args));
    if (res.ok) return { delivered: true, channel };
    return {
      delivered: false,
      channel,
      deliveryError: `${res.error}. ${channelSetupHint(channel)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { delivered: false, channel, deliveryError: `${msg}. ${channelSetupHint(channel)}` };
  }
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["morning", "evening", "test"],
          description: "Which brief to run. Default test.",
        },
        deliver: {
          type: "boolean",
          description: "Whether to send the brief to the configured channel. Default true.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<ActionResult> => {
      const { kind: rawKind, deliver: rawDeliver } = input as RunBriefInput;
      const kind =
        rawKind === "morning" || rawKind === "evening" || rawKind === "test" ? rawKind : "test";
      const shouldDeliver = rawDeliver !== false;

      const settings = await createSettingsRepository(appContext.db).get();
      const tz = settings.timezone || "UTC";
      const resultsRepo = createScoutResultsRepository(appContext.db);
      const briefsRepo = createBriefsRepository(appContext.db);

      const scoutResults = await resultsRepo.listUnconsumed();
      const recentBriefs = await briefsRepo.listRecent(10);
      const previousSuggestions = recentBriefs
        .slice(0, 5)
        .flatMap((brief) => suggestionsSection(brief.content) ?? []);
      const previousBriefs = previousDayBriefs(recentBriefs, new Date());
      // Any earlier brief, test runs included, already told them what isn't connected.
      const isFirstBrief = !recentBriefs.some((b) => b.status === "completed");
      const context = deliversToGuardian(settings, shouldDeliver)
        ? await gatherGuardianContext(appContext, tz)
        : null;
      const briefId = await briefsRepo.start(kind);

      // Synthesize the brief via the assistant agent; fall back deterministically.
      let content = "";
      let usedFallback = false;
      try {
        const summoned = unwrap(
          await appContext.runAction("summon", {
            agentName: "assistant",
            prompt: buildPrompt(
              kind,
              tz,
              scoutResults,
              context,
              previousSuggestions,
              previousBriefs,
              isFirstBrief,
            ),
          }),
        );
        if (summoned.ok) content = summonText(summoned.data);
        else log.warn("brief summon failed", { error: summoned.error });
      } catch (err) {
        log.warn("brief summon threw", { error: err instanceof Error ? err.message : String(err) });
      }
      if (!content) {
        content = fallbackBrief(kind, tz, scoutResults);
        usedFallback = true;
      }

      // Deliver (best-effort). The brief content is always stored regardless.
      let delivery: { delivered: boolean; channel: string; deliveryError?: string } = {
        delivered: false,
        channel: settings.channel,
      };
      if (shouldDeliver) {
        delivery = await deliver(appContext, settings, kind, content);
      }

      // Real scheduled briefs consume the scout findings so the next brief
      // doesn't repeat them. A test run leaves them for the real brief.
      if (kind !== "test") {
        await resultsRepo.markConsumed(scoutResults.map((r) => r.id));
      }

      await briefsRepo.finish(briefId, {
        status: "completed",
        content,
        channel: delivery.channel,
        delivered: delivery.delivered,
        deliveryError: delivery.deliveryError,
        scoutResultCount: scoutResults.length,
      });

      log.info("brief completed", {
        kind,
        delivered: delivery.delivered,
        scoutResults: scoutResults.length,
        usedFallback,
      });

      return {
        status: "ok",
        data: {
          briefId,
          kind,
          content,
          channel: delivery.channel,
          delivered: delivery.delivered,
          deliveryError: delivery.deliveryError,
          scoutResultCount: scoutResults.length,
          usedFallback,
        },
      };
    },
  };
}

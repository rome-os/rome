import type { ThreadContext } from "@rome-os/app-runtime";
import type { Audience, RomeTool, TurnFacts, WidgetDrawing } from "../agent/index.js";
import { parseShareLocationInput, shareLocationToolOutput } from "../webchat/location-card.js";

/**
 * Whether the person who reads the running turn alone started it with their
 * own message: the guardian, proven by their signed-in session, or a
 * dashboard admin in a turn only they read. A turn something else started (a
 * followed event, a routine, a task's result, another agent) acts for the
 * guardian only by loopback, so its card never shares by itself.
 */
export function startedByItsReader(turn: TurnFacts): boolean {
  // The actor is a SessionActor, which says how guardianship was proven.
  const actor = turn.actor() as { kind: string; via?: string } | undefined;
  if (actor?.kind === "visitor") return turn.audience() === "admin";
  return actor?.kind === "guardian" && actor.via === "cookie";
}

/** Whether the running turn is read by one person on the team alone. */
export type PrivateTurn = (turn: TurnFacts) => Promise<boolean>;

/**
 * The {@link PrivateTurn} rule over `chatAudience`, who can read a chat now:
 * the turn is read by one person (`private` or `admin`), and its chat still
 * reads the same, so a chat that opens to others after the turn started, or
 * whose dashboard admin left the team, is no longer private.
 */
export function privateTurnOf(
  chatAudience: (place: ThreadContext | undefined) => Promise<Audience>,
): PrivateTurn {
  return async (turn) => {
    const audience = turn.audience();
    return audience !== "shared" && (await chatAudience(turn.threadContext())) === audience;
  };
}

/**
 * `share_location`, served with the session's own tools. In a private turn
 * where cards show, the turn waits on the share-location card; anywhere else
 * the handler says why it cannot ask, for the model to pass on. A session with
 * no speaker (a fork) keeps the tool, so its catalog matches its source, and
 * the handler refuses.
 */
export function shareLocationTools(input: {
  turn: TurnFacts;
  widgets: WidgetDrawing;
  hasSpeaker: boolean;
  /** Absent, no turn is private and the tool always refuses. */
  privateTurn?: PrivateTurn;
}): RomeTool[] {
  const widgetsShow = input.widgets === "card";
  const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  return [
    {
      name: "share_location",
      endsTurn: widgetsShow,
      description:
        'Ask the guardian to share their current location once, through a card in the chat. Use it when the answer depends on where they are right now, such as "what\'s near me", "how far is the airport" or "will it rain here". A request for places (restaurants, cafes, shops, things to do) that names no place means near them: use this card, never ask which city. Use another place only when they name one or say not nearby. Don\'t ask preferences such as cuisine or budget first: suggest a varied few, then let them narrow. The answer comes back as the next turn: the latitude, longitude, accuracy in meters and when the fix was taken (no address; use your own tools to look up the place), or that they chose not to share. Each answer covers only the message it was asked for. If they don\'t share, answer that message without it or ask in text which place they mean, and don\'t show the card again for it. A later message that again needs their current position gets a new card, whether they shared or declined before: a decline is not a standing no, and a shared location is not kept. It works only in a chat that the guardian alone reads; elsewhere it says why it can\'t ask.',
      inputSchema: {
        type: "object",
        required: ["reason"],
        properties: {
          reason: {
            type: "string",
            description:
              'One short line, shown on the card, saying why you need the location, such as "To find coffee shops near you".',
          },
        },
      },
      handler: async (args) => {
        if (!input.hasSpeaker) return refuse("share_location is unavailable in a forked turn.");
        const parsed = parseShareLocationInput(args);
        if (!parsed.ok) return refuse(parsed.error);
        if (!widgetsShow) {
          return refuse(
            "This chat can't show the location card. Ask the guardian in a message which place they mean.",
          );
        }
        if (!(await input.privateTurn?.(input.turn))) {
          return refuse(
            "Can't ask for the location here: others can read this chat, so the location would be shared with them. " +
              "Tell the guardian that, and ask in a message which place they mean.",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                shareLocationToolOutput(parsed.reason, startedByItsReader(input.turn)),
              ),
            },
          ],
        };
      },
    },
  ];
}

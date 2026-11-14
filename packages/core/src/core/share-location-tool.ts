import type { RomeTool, TurnFacts, WidgetDrawing } from "../agent/index.js";
import { parseShareLocationInput, shareLocationToolOutput } from "../webchat/location-card.js";

/**
 * Whether the guardian's own message started the running turn: the guardian,
 * proven by their signed-in session. A turn something else started (a
 * followed event, a routine, a task's result, another agent) acts for the
 * guardian only by loopback, so its card never shares by itself.
 */
export function startedByGuardian(turn: TurnFacts): boolean {
  // The actor is a SessionActor, which says how guardianship was proven.
  const actor = turn.actor() as { kind: string; via?: string } | undefined;
  return actor?.kind === "guardian" && actor.via === "cookie";
}

/** Whether the running turn is read by the guardian alone. */
export type PrivateTurn = (turn: TurnFacts) => Promise<boolean>;

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
        'Ask the guardian to share their current location once, through a card in the chat. Use it only when the answer depends on where they are right now, such as "what\'s near me", "how far is the airport" or "will it rain here". Don\'t use it when the message names a place, or when a city you already know is enough. The answer comes back as the next turn: the latitude, longitude, accuracy in meters and when the fix was taken (no address; use your own tools to look up the place), or that they chose not to share. Each answer covers only the message it was asked for. If they don\'t share, answer that message without it or ask in text which place they mean, and don\'t show the card again for it. A later message that again needs their current position gets a new card, whether they shared or declined before: a decline is not a standing no, and a shared location is not kept. It works only in a chat that the guardian alone reads; elsewhere it says why it can\'t ask.',
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
                shareLocationToolOutput(parsed.reason, startedByGuardian(input.turn)),
              ),
            },
          ],
        };
      },
    },
  ];
}

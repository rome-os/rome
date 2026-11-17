import type { RomeTool, WidgetDrawing } from "../agent/index.js";
import {
  agentCardPart,
  SHOW_CARD_INPUT_SCHEMA,
  SHOW_CARD_TOOL,
  showCardDescription,
} from "../chats/agent-card.js";

/**
 * `show_card`, served with the session's own tools to every agent but the
 * Concierge, which has its own. Where cards show, the result carries the card
 * (`showWidget`) and the webchat drain stores it, trusting it only from this
 * tool (`trustedWidget` in api/routes/webchat.ts). Anywhere else, and in a fork
 * with no speaker, the handler says why it cannot show one, for the model to
 * write the content as text. docs/domains/chats.md#agent-card
 */
export function showCardTools(input: { widgets: WidgetDrawing; hasSpeaker: boolean }): RomeTool[] {
  const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  return [
    {
      name: SHOW_CARD_TOOL,
      description: showCardDescription("write the content in your reply"),
      inputSchema: SHOW_CARD_INPUT_SCHEMA,
      handler: async (args, call) => {
        if (!input.hasSpeaker || input.widgets !== "card") {
          return refuse(
            "This chat cannot show cards. Nothing was shown: write the content in your reply instead.",
          );
        }
        const card = agentCardPart(args.ui, args.text, call?.toolUseId ?? "show-card");
        if ("problems" in card) {
          return refuse(
            `The card was not shown: ${card.problems.join("; ")}. Fix it and call show_card once more, or write the content in your reply instead.`,
          );
        }
        const { ui, text } = card.part;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                showWidget: true,
                appId: "core",
                ui,
                text,
                note: "Shown: the guardian sees the card. Write nothing that repeats it: at most one short line that adds what the card does not hold, or nothing.",
              }),
            },
          ],
        };
      },
    },
  ];
}

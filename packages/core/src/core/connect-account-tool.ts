import type { RomeTool, WidgetDrawing } from "../agent/index.js";
import {
  connectableKinds,
  connectAccountToolOutput,
  parseConnectAccountInput,
} from "../connections/connect-card.js";

/**
 * `connect_account`, served with the session's own tools. Where the place
 * draws cards the turn waits on the connect card; elsewhere the model asks the
 * guardian to connect in Settings. A session with no speaker (a fork) keeps the
 * tool, so its catalog matches its source, and the handler refuses.
 */
export function connectAccountTools(input: {
  widgets: WidgetDrawing;
  hasSpeaker: boolean;
}): RomeTool[] {
  const widgetsShow = input.widgets === "card";
  return [
    {
      name: "connect_account",
      endsTurn: widgetsShow,
      description:
        "Ask the guardian to connect an account of a kind Rome connects itself, such as GitHub, Slack or Shopify, through a card in the chat. Call it when a task needs one of these and it is not connected, or a call reports it is not connected. The card opens the provider's authorization page; whether the guardian connected it or dismissed the card comes back as the next turn. Where no card shows, ask the guardian to connect it in Settings › Connections.",
      inputSchema: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: connectableKinds(),
            description: "The kind of connection to connect.",
          },
        },
      },
      handler: async (args) => {
        if (!input.hasSpeaker) {
          return {
            content: [{ type: "text", text: "connect_account is unavailable in a forked turn." }],
            isError: true,
          };
        }
        const parsed = parseConnectAccountInput(args);
        if (!parsed.ok) return { content: [{ type: "text", text: parsed.error }], isError: true };
        const output = connectAccountToolOutput(parsed.kind, widgetsShow);
        return {
          content: [
            { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
          ],
        };
      },
    },
  ];
}

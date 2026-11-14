import type { RomeTool, WidgetDrawing } from "../agent/index.js";
import {
  connectableKinds,
  connectAccountToolOutput,
  type DeviceKind,
  deviceConnectToolOutput,
  parseConnectAccountInput,
} from "../connections/connect-card.js";

/**
 * `connect_account`, served with the session's own tools. Where the place
 * draws cards the turn waits on the connect card; elsewhere the model asks the
 * guardian to connect in Settings. A session with no speaker (a fork) keeps the
 * tool, so its catalog matches its source, and the handler refuses.
 * `devicesOnly` serves it for device kinds alone, beside a session's own card
 * for the kinds Rome connects itself (the Concierge's `connect_card`); with
 * no device kind reported, there is then no tool.
 */
export function connectAccountTools(input: {
  widgets: WidgetDrawing;
  hasSpeaker: boolean;
  /** The device kinds devices reported, read when the session's tools are built. */
  devices?: readonly DeviceKind[];
  devicesOnly?: boolean;
}): RomeTool[] {
  const widgetsShow = input.widgets === "card";
  const devices = input.devices ?? [];
  if (input.devicesOnly && devices.length === 0) return [];
  const kinds = [...(input.devicesOnly ? [] : connectableKinds()), ...devices.map((d) => d.kind)];
  return [
    {
      name: "connect_account",
      endsTurn: widgetsShow,
      description: input.devicesOnly
        ? "Ask the guardian to connect a capability of one of their devices, such as Apple Health on an iPhone, through a card in the chat. Call it when they ask to connect one, or a personal-data reply says `not_connected` or a device connection is `off`. The card opens the device's own flow; whether the guardian connected it or dismissed the card comes back as the next turn."
        : "Ask the guardian to connect an account of a kind Rome connects itself, such as GitHub, Slack or Shopify, or a capability of one of their devices, such as Apple Health on an iPhone, through a card in the chat. Call it when a task needs one of these and it is not connected, or a call reports it is not connected. The card opens the provider's authorization page, or the device's own flow; whether the guardian connected it or dismissed the card comes back as the next turn. Where no card shows, ask the guardian to connect it in Settings › Connections.",
      inputSchema: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: kinds,
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
        const parsed = input.devicesOnly
          ? parseConnectAccountInput(args, devices, { devicesOnly: true })
          : parseConnectAccountInput(args, devices);
        if (!parsed.ok) return { content: [{ type: "text", text: parsed.error }], isError: true };
        const output = parsed.device
          ? deviceConnectToolOutput(parsed.device, widgetsShow)
          : connectAccountToolOutput(parsed.kind, widgetsShow);
        return {
          content: [
            { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
          ],
        };
      },
    },
  ];
}

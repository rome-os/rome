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
        ? "Ask the guardian to connect a capability of one of their devices, such as Apple Health on an iPhone, through a card in the chat. Call it here, in this chat, before starting a task that needs it, when they ask to connect one, when the capability you need is `off` or `broken` below, or when a reply or a device says `not_connected` or `live_off`. Never ask whether a device is connected: read it below. Never show the card again for a kind whose card the guardian just answered. The card opens the device's own flow; whether the guardian connected it or dismissed the card comes back as the next turn." +
          deviceStates(devices)
        : "Ask the guardian to connect an account of a kind Rome connects itself, such as GitHub, Slack or Shopify, or a capability of one of their devices, such as Apple Health on an iPhone, through a card in the chat. Call it when a task needs one of these and it is not connected, or a call reports it is not connected. The card opens the provider's authorization page, or the device's own flow; whether the guardian connected it or dismissed the card comes back as the next turn. Where no card shows, ask the guardian to connect it in Settings › Connections." +
          deviceStates(devices),
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
        const parsed = parseConnectAccountInput(args, devices, {
          devicesOnly: input.devicesOnly,
        });
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

/**
 * The device kinds as they stand now, for the description: an agent reads
 * whether a capability is working instead of asking the guardian.
 */
function deviceStates(devices: readonly DeviceKind[]): string {
  const known = devices.filter((d) => d.state);
  if (known.length === 0) return "";
  const lines = known.map(
    (d) => `\`${d.kind}\` (${d.label}${d.device ? ` on ${d.device}` : ""}): ${d.state}`,
  );
  return ` Device connections now: ${lines.join("; ")}.`;
}

import type { RomeTool, WidgetDrawing } from "../agent/index.js";
import {
  connectableKinds,
  connectCardRequest,
  connectCardToolOutput,
  type DeviceKind,
  type DeviceKindState,
} from "../connections/connect-card.js";

/**
 * A device kind's id is whatever its device chose, and an id such as `device`
 * reads as "connect a device", so the tool says what a device kind is and that
 * no card brings an offline device back.
 */
const NOT_A_DEVICE =
  "A device kind turns on one capability, in the Rome app of a device that already reported it. " +
  "It never adds, pairs or wakes a device: when a device is offline or a call to it answers " +
  "`target_unavailable`, show no card and ask the guardian to bring that device online.";

/**
 * The `kind` argument's description: each device kind with what its device
 * says it lets Rome do. It names no state or device, which change during a
 * session while its tools stay the same.
 */
function kindDescription(devices: readonly DeviceKind[]): string {
  const base = "The kind of connection to connect.";
  if (devices.length === 0) return base;
  const listed = devices
    .map((d) => `"${d.kind}" is ${d.label}${d.summary ? ` (${d.summary.replace(/\.$/, "")})` : ""}`)
    .join("; ");
  return `${base} Device kinds, each one capability a device reported: ${listed}.`;
}

/**
 * `connect_service`, served with the session's own tools. Where the place
 * draws cards the turn waits on the connect card; elsewhere the model asks the
 * guardian to connect in Settings. A session with no speaker (a fork) keeps the
 * tool, so its catalog matches its source, and the handler refuses.
 * `devicesOnly` serves it for device kinds alone, beside a session's own card
 * for the kinds Rome connects itself (the Concierge's `connect_card`); with
 * no device kind reported, there is then no tool.
 */
export function connectServiceTools(input: {
  widgets: WidgetDrawing;
  hasSpeaker: boolean;
  /** The device kinds devices reported, read when the session's tools are built. */
  devices?: readonly DeviceKind[];
  /**
   * How a device kind stands for this turn when the tool is called: on the
   * device the guardian asks from, when the turn has one, never on another.
   */
  deviceState?: (kind: string) => DeviceKindState | undefined;
  /** The guardian's language, which a device card's words follow. */
  language?: () => Promise<string | null>;
  devicesOnly?: boolean;
}): RomeTool[] {
  const widgetsShow = input.widgets === "card";
  const devices = input.devices ?? [];
  if (input.devicesOnly && devices.length === 0) return [];
  const kinds = [...(input.devicesOnly ? [] : connectableKinds()), ...devices.map((d) => d.kind)];
  return [
    {
      name: "connect_service",
      endsTurn: widgetsShow,
      description: input.devicesOnly
        ? `Ask the guardian to connect a capability of one of their devices, such as Apple Health on an iPhone, through a card in the chat. Call it here, in this chat, before starting a task that reads a device, when they ask to connect one, or when a reply or a device says \`not_connected\` or \`live_off\`. It answers at once that a kind already works, with no card, so call it instead of asking whether a device is connected. Never show the card again for a kind whose card the guardian just answered. The card opens the device's own flow; whether the guardian connected it or dismissed the card comes back as the next turn. ${NOT_A_DEVICE}`
        : `Ask the guardian to connect an account of a kind Rome connects itself, such as GitHub, Slack or Shopify, or a capability of one of their devices, such as Apple Health on an iPhone, through a card in the chat. Call it when a task needs one of these and it is not connected, or a call reports it is not connected. The card opens the provider's authorization page, or the device's own flow; whether the guardian connected it or dismissed the card comes back as the next turn. Where no card shows, ask the guardian to connect it in Settings › Connections.${devices.length > 0 ? ` ${NOT_A_DEVICE}` : ""}`,
      inputSchema: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: kinds,
            description: kindDescription(devices),
          },
        },
      },
      handler: async (args) => {
        if (!input.hasSpeaker) {
          return {
            content: [{ type: "text", text: "connect_service is unavailable in a forked turn." }],
            isError: true,
          };
        }
        const request = await connectCardRequest(args, {
          devices,
          deviceState: input.deviceState,
          language: input.language,
          devicesOnly: input.devicesOnly,
        });
        if (request.status === "refused") {
          return { content: [{ type: "text", text: request.error }], isError: true };
        }
        const output = connectCardToolOutput(request, widgetsShow);
        return {
          content: [
            { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
          ],
        };
      },
    },
  ];
}

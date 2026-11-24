import {
  declaresComputerUse,
  type AgentComputerUse,
  type ComputerOperation,
} from "../domain/computer-use.js";
import type { RomeTool } from "../domain/rome-tools.js";
import type { TurnFacts } from "../domain/turn-facts.js";

const id = { type: "string", minLength: 1, maxLength: 200 };
const application = { ...id, description: "Exact application name or bundle identifier." };
const session = { sessionId: id };
const binding = {
  deviceId: id,
  windowRef: id,
  application,
  backgroundOnly: {
    type: "boolean",
    description:
      "Set true when the task requires the target to remain in the background throughout.",
  },
  lease: {
    type: "boolean",
    description:
      "Require a renewable lease. Signed remote hosts enable advertised leases automatically.",
  },
  requireSessionEnd: { type: "boolean", description: "Require advertised normal end support." },
};
const coordinate = { type: "number", minimum: 0, maximum: 16384 };
const observationRegion = {
  type: "object",
  description:
    "AX observation rectangle in window image pixels. The returned screenshot, if requested, still covers the bound window.",
  properties: {
    x: { ...coordinate, type: "integer" },
    y: { ...coordinate, type: "integer" },
    width: { ...coordinate, type: "integer", minimum: 1 },
    height: { ...coordinate, type: "integer", minimum: 1 },
    fromEnd: {
      type: "boolean",
      description:
        "Start traversal from the last child of each branch. Sibling indices still describe the original order.",
    },
  },
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
};
const action = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "move",
        "click",
        "drag",
        "scroll",
        "key",
        "type",
        "press",
        "setValue",
        "selectText",
        "performAction",
      ],
    },
    value: {
      type: "string",
      maxLength: 16384,
      description:
        "setValue: replace an advertised editable AX field. Empty clears it. Respect the binding's maxValueLength.",
    },
    x: {
      ...coordinate,
      description: "Bound-window screenshot pixel x, if coordinate input is advertised.",
    },
    y: {
      ...coordinate,
      description: "Bound-window screenshot pixel y, if coordinate input is advertised.",
    },
    toX: coordinate,
    toY: coordinate,
    durationMs: {
      type: "integer",
      minimum: 100,
      maximum: 2000,
      description: "drag only: movement duration. Drag always uses the left button; omit button.",
    },
    button: {
      type: "string",
      enum: ["left", "right"],
      description: "click only. Omit this field for drag and every other action.",
    },
    clickCount: {
      type: "integer",
      minimum: 1,
      maximum: 2,
      description: "click only: one or two clicks.",
    },
    deltaX: { type: "integer", minimum: -2000, maximum: 2000 },
    deltaY: {
      type: "integer",
      minimum: -2000,
      maximum: 2000,
      description: "scroll: positive is down, negative is up.",
    },
    key: {
      type: "string",
      maxLength: 32,
      description:
        "Named key (Return, Tab, Escape, Backspace, arrows, Home, End, PageUp/Down, F1-F12), A-Z, 0-9 or punctuation.",
    },
    modifiers: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: ["command", "control", "alt", "shift"] },
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description:
        "type: insert Unicode text without using the clipboard. This does not emulate IME composition.",
    },
    prefix: { type: "string", maxLength: 4096 },
    suffix: { type: "string", maxLength: 4096 },
    selectionType: { type: "string", enum: ["text", "cursor_before", "cursor_after"] },
    action: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "performAction: an AX action actually advertised by this element.",
    },
  },
  required: ["type"],
  additionalProperties: false,
};

export function computerTools(computer: AgentComputerUse | undefined, turn: TurnFacts): RomeTool[] {
  // Catalogs open before a turn exists. Runtime admission stays in each callback.
  if (!computer || !declaresComputerUse(turn.actions)) return [];
  const tool = (
    operation: ComputerOperation,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): RomeTool => ({
    name: `computer_${operation}`,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    handler: async (input) => {
      if (!computer.permits(turn)) {
        return {
          content: [{ type: "text", text: "Computer use is unavailable to this turn." }],
          isError: true,
        };
      }
      try {
        return await computer.run(turn, operation, input);
      } catch {
        return {
          content: [
            { type: "text", text: "Computer-use request failed. Do not replay an unknown action." },
          ],
          isError: true,
        };
      }
    },
  });
  return [
    tool(
      "status",
      "List authorized computers or inspect a device's helper. If the message has approvedDeviceId, use that exact target. Otherwise, for this computer, resolve askingDeviceId from the authorized list. Call computer_discover on the selected device before deciding which capabilities to use. Ask when the target is ambiguous.",
      { deviceId: id },
    ),
    tool(
      "discover",
      "Read this device's advertised actions, computer-use capabilities, permissions, and readiness. Devices can run different versions. When present, authorizedActions lists the commands this message can call. Use binaryFrames to check the transport before requesting a screenshot. Missing capabilities remain unknown. Discover each target separately and never switch targets implicitly.",
      { deviceId: id },
      ["deviceId"],
    ),
    tool(
      "windows",
      "List supported windows on a device. Pass application when the task names a target app. It matches appName or bundleId exactly, independent of window title. An empty list means the device found no eligible window for that app. Window references are opaque and expire. Do not substitute process ids.",
      { deviceId: id, application },
      ["deviceId"],
    ),
    tool(
      "bind",
      "Bind an explicitly listed background window. Pass the same application name or bundle identifier used to list a named target. If the window becomes unavailable or the user takes focus, list windows again on the same device when the target is in the background. If the binding returns a lease, use computer_renew by the returned interval. A window in another Space or a non-key window in the user's foreground app may offer window_semantics. Use its advertised AX actions with a fresh element ref.",
      binding,
      ["deviceId", "windowRef"],
    ),
    tool(
      "preempt",
      "Replace the exact automation holding a background window only with explicit permission in this turn. Use the same device and windowRef and the preemptToken returned by a busy bind. Wait for confirmed cleanup before using the replacement session. A preemption_pending reply allows the same token to be checked again. Never retry an unknown preemption.",
      { ...binding, preemptToken: { ...id, maxLength: 128 } },
      ["deviceId", "windowRef", "preemptToken"],
    ),
    tool(
      "observe",
      "Read the bound window's structured accessibility tree. The compact view folds empty single-child groups. Apply elementDefaults only to elements returned in this reply. An explicit field replaces the default, including an empty action list. To inspect one branch in detail, use view:detailed with the subtreeRef of a current element. If that ref came from a region, pass the same region. Screenshots are off by default. If visible order or layout is unclear, request a window screenshot and use the image block directly. With advertised observationRegion support, read just the relevant pane using region. When that region is cut off, read it again with region.fromEnd or a smaller rectangle. Changing view, subtree, region, or traversal returns a fresh full observation. For the latest N items, establish list order from timestamps or visible list controls and count distinct top-level entries. AX traversal can include hidden rows and replies. Use overlapping views when scrolling is needed and supported. Act promptly using the latest observationId and stateVersion. Keep unchanged refs only from the same delta lineage. If a visible control is missing, center a small region on it or widen the region to include its layout ancestors. An incomplete tree cannot prove an element is absent.",
      {
        ...session,
        screenshot: { type: "boolean" },
        full: { type: "boolean" },
        region: observationRegion,
        view: { type: "string", enum: ["compact", "detailed"] },
        subtreeRef: { ...id, description: "Show this observation element and its descendants." },
      },
      ["sessionId"],
    ),
    tool(
      "act",
      "Perform one advertised window action against fresh state. Read visible list items directly and scroll as needed. Open an item when the task requires details beyond the list. A floating pane and the page beneath it can have buttons at the same pixel. Locate Back or Close on the image if needed, then observe its toolbar and match the button to the pane by ancestry. Use its advertised press with the fresh ref. If only the underlying button appears, widen the region to include the pane header and adjacent content. Prefer refs to coordinates for click and scroll. press/setValue/selectText/performAction require ref. setValue needs value; selectText needs text and optional prefix/suffix/selectionType; performAction needs an advertised AX action name. key/type can target a ref. A window_semantics binding requires ref for every action and offers only click/press/setValue/selectText. In that mode click is a single left AX press, text edits use setValue, and no keyboard or pointer events are available. Coordinates otherwise use bound-window image pixels. Use navigation for a repeatable link that leaves the current page. Device-specific input delivery is handled by the host. Use expect and verifyAfter for a checkable postcondition. After an unverified pointer click, observe the target again. If the UI has not changed, do not repeat the same click or try a shortcut without fresh evidence that the window and control can receive it. If stale_observation reports effectStatus not_dispatched, observe again and decide with a new actionId. If that reply also confirms the old stop, list and bind the same approved window first. Never replay an unknown outcome or reuse actionId.",
      {
        ...session,
        actionId: { ...id, maxLength: 100 },
        observationId: id,
        stateVersion: { type: "integer", minimum: 0 },
        ref: id,
        action,
        navigation: {
          type: "boolean",
          description:
            "For a single click by ref, true means opening the same destination twice is harmless and successful navigation removes this source control. Omit for commands, toggles, submissions or controls that remain after navigation.",
        },
        expect: {
          type: "object",
          properties: Object.fromEntries(
            ["role", "identifier", "title", "value", "contains"].map((name) => [
              name,
              { type: "string", maxLength: 4096 },
            ]),
          ),
          additionalProperties: false,
          description:
            "Independent AX postcondition. All supplied fields must match one unique element; contains matches its value. Without a checkable postcondition, generic input remains unverified.",
        },
        verifyAfter: { type: "boolean" },
      },
      ["sessionId", "actionId", "observationId", "stateVersion", "action"],
    ),
    tool(
      "verify",
      "Read independent evidence for an issued action. A cancelled or unknown action cannot become successful.",
      { ...session, actionId: { ...id, maxLength: 100 } },
      ["sessionId", "actionId"],
    ),
    tool(
      "cancel",
      "Cancel this computer-use session. Older bindings without normal end support use this operation. Check result.stopConfirmed for verified remote stop. Already dispatched input cannot be replayed or undone.",
      session,
      ["sessionId"],
    ),
    tool(
      "end",
      "Normally end a session whose binding advertises sessionEnd. Check stopConfirmed independently from any action result. A pending stop can be checked again with this same session ID.",
      session,
      ["sessionId"],
    ),
    tool(
      "renew",
      "Extend an active renewable window lease before its idle deadline, using the binding's lease guidance. An expired or stopped session requires a fresh bind. Renewal never resends actions.",
      session,
      ["sessionId"],
    ),
    tool(
      "recover",
      "Read the recorded outcome and any prior independent verification of this actionId on the approved device after a lost response or reconnect. Dispatch status and stopConfirmed answer separate questions. Recovery cannot send input, obtain a binding, or make an old action safe to replay.",
      { deviceId: id, actionId: { ...id, maxLength: 100 } },
      ["deviceId", "actionId"],
    ),
  ];
}

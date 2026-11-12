// What a routine, an app or another agent sends into a Concierge chat. A
// Concierge chat holds only its owner's messages and the Concierge's, so such a
// send is no message there: it runs as a quiet system turn whose input stays
// in the turn's trace (docs/architecture/concierge.md).

import type { SystemInputSource } from "@rome/api-types/trace-segments";

/** Who sent an automated input, as the chat names it. */
export interface AutomatedInputSender {
  sourceType: "agent" | "app" | "routine" | null;
  name: string | null;
}

const KIND_LABEL: Record<SystemInputSource["type"], string> = {
  routine: "Routine",
  app: "App",
  agent: "Agent",
  automation: "Automation",
};

/** The source a turn's trace and the chat's faint line name. */
export function automatedInputSource(sender: AutomatedInputSender): SystemInputSource {
  return {
    type: sender.sourceType ?? "automation",
    name: sender.name?.trim() || null,
  };
}

/** The trace label of the input, such as "Routine · Daily summary". */
export function automatedInputLabel(source: SystemInputSource): string {
  const kind = KIND_LABEL[source.type];
  return source.name ? `${kind} · ${source.name}` : kind;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The Concierge's input for an automated send: the text, fenced so it reads
 * as the source's and not the owner's. A closing tag inside the text cannot
 * end the block early.
 */
export function automatedInputPrompt(source: SystemInputSource, text: string): string {
  const name = source.name ? ` name="${attr(source.name)}"` : "";
  const body = text.replace(/<\/automated_input>/gi, "</automated_input_>");
  return `<automated_input source="${source.type}"${name}>\n${body}\n</automated_input>`;
}

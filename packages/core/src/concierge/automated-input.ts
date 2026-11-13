// What a routine, an app or another agent sends into a Concierge chat. A
// Concierge chat holds only its owner's messages and the Concierge's, so such a
// send is no message there: it runs as a quiet system turn whose input stays
// in the turn's trace (docs/architecture/concierge.md).

import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { isConciergeAgent } from "../webchat/privacy.js";

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

/** What the guard needs from Rome: which chats are Concierge chats, who an agent is, and a system turn. */
export interface ConciergeChatGuardDeps {
  isConciergeChat: (chatId: string) => Promise<boolean>;
  /** The sender an agent's account names, by agent id; anonymous when no agent sent it. */
  senderOf: (agentName: string | undefined) => Promise<AutomatedInputSender>;
  runSystemTurn: (
    chatId: string,
    prompt: string,
    options: {
      quiet: true;
      inputLabel: string;
      inputSource: SystemInputSource;
      pushLevel: "active";
    },
  ) => Promise<boolean>;
}

/**
 * A send into a Concierge chat that an app's action makes, as by
 * `system:send_message`, sent on as a quiet system turn of the Concierge: only
 * the Concierge writes its own chat's messages. Answers the receipt, or null
 * when the send is not into a Concierge chat, or the Concierge itself makes
 * it, and goes on as before.
 */
export function conciergeChatGuard(deps: ConciergeChatGuardDeps) {
  return async (
    target: { platform: string } | string,
    chatId: string,
    message: OutgoingMessage,
    agentName: string | undefined,
  ): Promise<MessageReceipt | null> => {
    const webchat =
      typeof target === "string" ? target === "webchat" : target.platform === "webchat";
    if (!webchat || isConciergeAgent(agentName) || !(await deps.isConciergeChat(chatId))) {
      return null;
    }
    const text =
      message.text?.trim() ||
      (message.parts ?? [])
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join("\n\n")
        .trim();
    if (!text) throw new Error("A Concierge chat takes only text from another agent or an app");
    const source = automatedInputSource(await deps.senderOf(agentName));
    void deps
      .runSystemTurn(chatId, automatedInputPrompt(source, text), {
        quiet: true,
        inputLabel: automatedInputLabel(source),
        inputSource: source,
        pushLevel: "active",
      })
      .catch(() => false);
    // Nothing is said in the chat, so the receipt names no message.
    return { chatId: chatId as ChatId };
  };
}

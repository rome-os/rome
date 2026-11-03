// The prompt blocks that carry a replied-to message to the agent. Channel
// inbound replies and WebChat replies both build their block here, so the
// agent reads one format wherever the reply came from.

/** One quoted line: `[ISO] Sender: text`. The timestamp is left out when the message has none. */
export function replyContextLine(message: {
  createdAt?: Date;
  sender: string;
  text: string;
}): string {
  const timestamp = message.createdAt ? `[${message.createdAt.toISOString()}] ` : "";
  return `${timestamp}${message.sender}: ${message.text}`;
}

/** The `<reply_context>` block around an already formatted line, one string per line. */
export function replyContextSection(line: string): string[] {
  return ["<reply_context>", line, "</reply_context>"];
}

/** The `<current_message>` block around the turn's prompt, one string per line. */
export function currentMessageSection(prompt: string): string[] {
  return ["<current_message>", prompt, "</current_message>"];
}

/** Puts a replied-to line ahead of the prompt it answers. */
export function withReplyContext(prompt: string, line: string): string {
  return [...replyContextSection(line), ...currentMessageSection(prompt)].join("\n");
}

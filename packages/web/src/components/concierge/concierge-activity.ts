// What a Concierge chat's header says it is doing right now. Pure, so the
// order of the states is tested without a DOM. Every input is a fact the
// dashboard already holds (a running turn, the tool it is in, a task chat
// running or waiting); none is a state the Concierge writes itself.

import type { TraceSnapshot } from "@rome/api-types/trace-segments";

/** A tool the Concierge is in, by what the header calls it. */
export type ConciergeToolActivity =
  | "startingTask"
  | "messagingTask"
  | "readingTask"
  | "stoppingTask"
  | "updatingTasks"
  | "startingTopic"
  | "checkingFollows"
  | "searchingWeb"
  | "readingPage";

export type ConciergeActivity =
  /** Nothing is running and nothing waits. */
  | { kind: "idle" }
  /** A question or approval waits on the guardian, here or in a task chat. */
  | { kind: "needsYou" }
  /** The Concierge's own turn is running, in a tool the header names. */
  | { kind: "tool"; tool: ConciergeToolActivity }
  /** The Concierge's own turn is running. */
  | { kind: "working" }
  /** Task chats this chat started are running: the newest one's title, and how many more. */
  | { kind: "tasks"; title: string; more: number };

/** A task chat this Concierge chat started, as the header reads it. */
export interface TaskChatActivity {
  title: string;
  running: boolean;
  awaitingGuardian: boolean;
  /** When its row last changed: the newest running task leads. */
  updatedAt: number;
}

export interface ConciergeActivityInput {
  /** The chat's own turn is streaming. */
  streaming: boolean;
  /** The chat's own turn waits on a card or an approval. */
  awaitingGuardian: boolean;
  /** The streaming turn's trace, when there is one. */
  snapshot: TraceSnapshot | null;
  tasks: readonly TaskChatActivity[];
}

// Tools whose work the guardian sees as the reply itself: the header says
// "working" while the Concierge is in them, not a tool of its own.
const TOOL_ACTIVITY: Record<string, ConciergeToolActivity> = {
  chat_start: "startingTask",
  chat_send: "messagingTask",
  chat_read: "readingTask",
  chat_list: "readingTask",
  chat_stop: "stoppingTask",
  task_upsert: "updatingTasks",
  task_list: "updatingTasks",
  topic_start: "startingTopic",
  concierge_following_list: "checkingFollows",
  web_search: "searchingWeb",
  websearch: "searchingWeb",
  web_fetch: "readingPage",
  webfetch: "readingPage",
};

/** A tool name without its provider or group prefix (`mcp__rome__chat_start`, `core:chat_start`). */
function bareToolName(tool: string): string {
  const afterMcp = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  const afterNamespace = afterMcp.includes(":")
    ? afterMcp.slice(afterMcp.lastIndexOf(":") + 1)
    : afterMcp;
  return afterNamespace.toLowerCase();
}

/** The tool the streaming turn is in now: its latest call with no result yet. */
export function openToolOf(snapshot: TraceSnapshot | null): string | null {
  if (!snapshot) return null;
  const finished = new Set<string>();
  let open: string | null = null;
  for (const segment of snapshot.segments) {
    const blocks = segment.kind === "run" ? segment.blocks : [segment.block];
    for (const block of blocks) {
      if (block.type === "tool_result" && block.toolUseId) finished.add(block.toolUseId);
    }
  }
  for (const segment of snapshot.segments) {
    const blocks = segment.kind === "run" ? segment.blocks : [segment.block];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      if (block.toolUseId && finished.has(block.toolUseId)) continue;
      open = block.tool;
    }
  }
  return open;
}

/** The tool activity the header names for a tool, or null for one it shows as plain work. */
export function toolActivityOf(tool: string): ConciergeToolActivity | null {
  return TOOL_ACTIVITY[bareToolName(tool)] ?? null;
}

/**
 * What the header says, in order: something waiting on the guardian first,
 * then the Concierge's own turn (the tool it is in, else plain work), then the
 * task chats it started that are running, else nothing.
 */
export function conciergeActivity(input: ConciergeActivityInput): ConciergeActivity {
  if (input.awaitingGuardian || input.tasks.some((task) => task.awaitingGuardian)) {
    return { kind: "needsYou" };
  }
  if (input.streaming) {
    const tool = openToolOf(input.snapshot);
    const activity = tool ? toolActivityOf(tool) : null;
    return activity ? { kind: "tool", tool: activity } : { kind: "working" };
  }
  const running = input.tasks
    .filter((task) => task.running)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const [first, ...rest] = running;
  if (first) return { kind: "tasks", title: first.title, more: rest.length };
  return { kind: "idle" };
}

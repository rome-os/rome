// What a Concierge chat is doing right now, as its header says it. Core
// computes it from facts it holds (a running turn, the tool it is in, a task
// chat running or waiting on the guardian, a task result about to be
// reported) and pushes it on the `concierge.activity` live-events topic; the
// clients only say it. None of it is a state the Concierge writes.

/** A tool the Concierge is in, by what the header calls it. */
export type ConciergeToolActivity =
  | "startingTask"
  | "messagingTask"
  | "readingChat"
  | "stoppingTask"
  | "updatingTasks"
  | "startingTopic"
  | "checkingFollows"
  | "searchingWeb"
  | "readingPage";

export type ConciergeActivity =
  /** Nothing is running and nothing waits. */
  | { kind: "idle" }
  /** A card or an approval waits on the owner, in this chat or in a task chat it started. */
  | { kind: "needsYou" }
  /** The chat's own turn is running, in a tool the header names. */
  | { kind: "tool"; tool: ConciergeToolActivity }
  /** The chat's own turn is running, or a task's result is about to be reported in it. */
  | { kind: "working" }
  /** Task chats this chat started are running: the newest one's title, and how many more. */
  | { kind: "tasks"; title: string; more: number };

/** Payload of the `concierge_activity` event on the `concierge.activity` topic. */
export interface ConciergeActivityEvent {
  /** The Concierge chat, main or topic. */
  chatId: string;
  activity: ConciergeActivity;
  /** When the activity took effect, epoch milliseconds. */
  at: number;
}

/** A task chat a Concierge chat started, as its activity reads it. */
export interface TaskChatActivityFacts {
  title: string;
  running: boolean;
  awaitingGuardian: boolean;
  /** When its row last changed, epoch milliseconds: the newest running task leads. */
  updatedAt: number;
}

/** The facts one Concierge chat's activity follows from. */
export interface ConciergeActivityFacts {
  /** A card or an approval waits on the owner in the chat itself. */
  awaitingGuardian: boolean;
  /** The chat's own turn, and the tool it is in now (a call whose result has not come back). */
  turn: { running: boolean; tool: string | null };
  /** A task's result waits for the turn that reports it. */
  reportPending: boolean;
  tasks: readonly TaskChatActivityFacts[];
}

// The tools the header names. Any other tool, `say` included, reads as plain
// work.
const TOOL_ACTIVITY: Record<string, ConciergeToolActivity> = {
  chat_start: "startingTask",
  chat_send: "messagingTask",
  chat_read: "readingChat",
  chat_list: "readingChat",
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

/** The activity the header names for a tool, or null for one it shows as plain work. */
export function toolActivityOf(tool: string): ConciergeToolActivity | null {
  return TOOL_ACTIVITY[bareToolName(tool)] ?? null;
}

/**
 * What a Concierge chat is doing, in order: something waiting on the owner
 * first, then the chat's own turn (the tool it is in, else plain work), then
 * a task result about to be reported, then the task chats it started that
 * are running, else nothing.
 */
export function conciergeActivity(facts: ConciergeActivityFacts): ConciergeActivity {
  if (facts.awaitingGuardian || facts.tasks.some((task) => task.awaitingGuardian)) {
    return { kind: "needsYou" };
  }
  if (facts.turn.running) {
    const tool = facts.turn.tool ? toolActivityOf(facts.turn.tool) : null;
    return tool ? { kind: "tool", tool } : { kind: "working" };
  }
  if (facts.reportPending) return { kind: "working" };
  const running = facts.tasks
    .filter((task) => task.running)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const [first, ...rest] = running;
  if (first) return { kind: "tasks", title: first.title, more: rest.length };
  return { kind: "idle" };
}

/** Whether two activities say the same thing. */
export function sameActivity(a: ConciergeActivity, b: ConciergeActivity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

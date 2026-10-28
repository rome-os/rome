import type { WelcomeNode, WelcomeProgress } from "../../db/repositories/progress.js";
import type { WelcomeStep } from "./copy.js";

const FALLBACK_AGENT_NAME = "Rome";
// The host qualifies the agent name with the app id when it creates the chat.
const WELCOME_AGENT_NAMES = new Set(["welcome-to-rome:welcome-to-rome", "welcome-to-rome"]);

export const STEPS: readonly WelcomeStep[] = ["names", "ai", "question", "ideas"];

// How far each state-machine cursor has got through STEPS. `done` is past the
// last one. The briefing-scout offer is part of the last step, since it comes
// right before the first-app ideas. Keyed by the server's node type, so a new
// node fails to compile here instead of reading as a first run.
const STEP_INDEX_BY_NODE: Record<Exclude<WelcomeNode, "greet">, number> = {
  await_names: 0,
  await_ai: 1,
  await_question: 2,
  await_scouts: 3,
  await_idea: 3,
  done: STEPS.length,
};

type LandingProgress = Pick<WelcomeProgress, "node" | "aiConnected" | "sessionId">;

/**
 * What the landing screen shows: a first run, a run to pick up, a finished
 * one, or an error when the run could not be read. Every state but the error
 * offers a button that resets the run, so a reset is offered only after the
 * state was read.
 */
export type Landing =
  | { kind: "fresh" }
  | { kind: "resume"; stepIndex: number; chatId: string | null; aiConnected: boolean | null }
  | { kind: "done"; chatId: string | null; aiConnected: boolean | null }
  | { kind: "error" };

export interface LandingData {
  agentName: string;
  landing: Landing;
}

type FetchHost = (path: string, init?: RequestInit) => Promise<Response>;
/** Records the chat found for an older run through the app's `POST /session`. */
type SaveChat = (sessionId: string) => Promise<unknown>;

function readAgentName(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : FALLBACK_AGENT_NAME;
}

function isNode(value: unknown): value is WelcomeNode {
  return (
    typeof value === "string" && (value === "greet" || Object.hasOwn(STEP_INDEX_BY_NODE, value))
  );
}

function readProgress(value: unknown): LandingProgress | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isNode(v.node)) return null;
  return {
    node: v.node,
    aiConnected: typeof v.aiConnected === "boolean" ? v.aiConnected : null,
    sessionId: typeof v.sessionId === "string" && v.sessionId ? v.sessionId : null,
  };
}

/**
 * Find the chat the welcome run lives in, or null when it is gone. Only a 404
 * means gone. Any other failure keeps the recorded chat, so Continue setup
 * stays on offer and the chat page reports its own error.
 *
 * A run that started before the progress row recorded its chat has no id, so
 * it falls back to the newest welcome chat, archived ones included: every start
 * from this screen resets the run, so the newest one is the run's own. That
 * list failing throws, because without it the screen cannot tell a missing
 * chat from a failed read.
 */
async function findWelcomeChat(
  sessionId: string | null,
  fetchHost: FetchHost,
  saveChat: SaveChat,
): Promise<string | null> {
  const init: RequestInit = { credentials: "include" };
  if (sessionId) {
    const res = await fetchHost(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, init).catch(
      () => null,
    );
    return res?.status === 404 ? null : sessionId;
  }
  // The chat found here is saved, so this full list runs once per older run.
  const res = await fetchHost("/api/chat/sessions?status=all", init);
  if (!res.ok) throw new Error(`chat list returned ${res.status}`);
  const sessions: unknown = await res.json();
  if (!Array.isArray(sessions)) throw new Error("chat list is not an array");
  const newest = sessions
    .filter(
      (s): s is { id: string; agentName: string; createdAt: string } =>
        !!s &&
        typeof s.id === "string" &&
        typeof s.agentName === "string" &&
        WELCOME_AGENT_NAMES.has(s.agentName) &&
        typeof s.createdAt === "string",
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!newest) return null;
  // Best-effort: a failed save only means the next visit searches again.
  await saveChat(newest.id).catch(() => undefined);
  return newest.id;
}

/**
 * Read the run's state through the app API, then find its chat through the
 * host's chat routes. A failed or unreadable state read is an error, never a
 * first run, since a first run's button resets the run.
 */
export async function loadLanding(
  fetchState: () => Promise<Response>,
  fetchHost: FetchHost,
  saveChat: SaveChat = async () => undefined,
): Promise<LandingData> {
  let data: { agentName?: unknown; progress?: unknown };
  try {
    const res = await fetchState();
    if (!res.ok) return { agentName: FALLBACK_AGENT_NAME, landing: { kind: "error" } };
    data = (await res.json()) as typeof data;
  } catch {
    return { agentName: FALLBACK_AGENT_NAME, landing: { kind: "error" } };
  }
  const agentName = readAgentName(data?.agentName);
  const progress = readProgress(data?.progress);
  if (!progress) return { agentName, landing: { kind: "error" } };
  if (progress.node === "greet") return { agentName, landing: { kind: "fresh" } };

  let chatId: string | null;
  try {
    chatId = await findWelcomeChat(progress.sessionId, fetchHost, saveChat);
  } catch {
    return { agentName, landing: { kind: "error" } };
  }
  const stepIndex = STEP_INDEX_BY_NODE[progress.node];
  if (stepIndex >= STEPS.length) {
    return { agentName, landing: { kind: "done", chatId, aiConnected: progress.aiConnected } };
  }
  return {
    agentName,
    landing: { kind: "resume", stepIndex, chatId, aiConnected: progress.aiConnected },
  };
}

/** How a Start chat or Start over press ended. */
export type StartOutcome = "started" | "reset_failed" | "start_failed";

/**
 * Reset the run, then open a new welcome chat. When a run is under way, the
 * chat opens only after the reset succeeded: a chat opened on top of a run
 * that was not reset would pick that run up, which is the opposite of
 * starting over. A run not yet started has nothing to lose, so its reset stays
 * best-effort.
 */
export async function startWelcomeRun(input: {
  runUnderWay: boolean;
  reset: () => Promise<Response>;
  openChat: () => Promise<unknown>;
}): Promise<StartOutcome> {
  const reset = await input.reset().catch(() => null);
  if (input.runUnderWay && !reset?.ok) return "reset_failed";
  try {
    await input.openChat();
    return "started";
  } catch {
    return "start_failed";
  }
}

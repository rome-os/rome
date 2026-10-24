import { eq } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import { createAppDbSchema } from "../schema.js";

const SINGLETON_ID = "default";

/** A brainstormed app idea: `title` is a short button-style label; `prompt` is
 *  the first-person message that, sent to Rome, kicks off building the app. */
export interface AppIdea {
  title: string;
  prompt: string;
}

/** State-machine cursor values. See the `runTurn` switch in
 *  ../../hooks/turn-middleware/script.ts. */
export type WelcomeNode =
  | "greet"
  | "await_names"
  | "await_ai"
  | "await_question"
  | "await_scouts"
  | "await_idea"
  | "done";

export interface WelcomeProgress {
  node: WelcomeNode;
  introRawInput: string | null;
  introSummary: string | null;
  ideas: AppIdea[];
  ideasGeneratedAt: string | null;
  /** Null until the connect-AI step resolves. */
  aiConnected: boolean | null;
  completedAt: string | null;
  /** The webchat chat this run lives in (the id in `/chat/<id>`). Null before
   *  the first turn, and for a run that started before the column existed. */
  sessionId: string | null;
}

const EMPTY: WelcomeProgress = {
  node: "greet",
  introRawInput: null,
  introSummary: null,
  ideas: [],
  ideasGeneratedAt: null,
  aiConnected: null,
  completedAt: null,
  sessionId: null,
};

interface ProgressPatch {
  node?: WelcomeNode;
  introRawInput?: string | null;
  introSummary?: string | null;
  appIdeas?: string | null;
  appIdeasGeneratedAt?: string | null;
  aiConnected?: boolean | null;
  completedAt?: string | null;
  sessionId?: string | null;
}

// A cursor from a script version that no longer exists reads as `greet`, so a
// conversation parked on a removed step restarts instead of stalling.
const NODES: readonly WelcomeNode[] = [
  "greet",
  "await_names",
  "await_ai",
  "await_question",
  "await_scouts",
  "await_idea",
  "done",
];

function readNode(v: unknown): WelcomeNode {
  return typeof v === "string" && (NODES as readonly string[]).includes(v)
    ? (v as WelcomeNode)
    : "greet";
}

export function encodeIdeas(ideas: AppIdea[]): string {
  return JSON.stringify(ideas);
}

function parseIdeas(v: unknown): AppIdea[] {
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) =>
      item &&
      typeof item === "object" &&
      typeof (item as AppIdea).title === "string" &&
      typeof (item as AppIdea).prompt === "string"
        ? [{ title: (item as AppIdea).title, prompt: (item as AppIdea).prompt }]
        : [],
    );
  } catch {
    return [];
  }
}

export class ProgressRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix: string,
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  get(): WelcomeProgress {
    const row = this.db
      .select()
      .from(this.tables.progress)
      .where(eq(this.tables.progress.id, SINGLETON_ID))
      .get();
    if (!row) return EMPTY;
    return {
      node: readNode(row.node),
      introRawInput: row.introRawInput,
      introSummary: row.introSummary,
      ideas: parseIdeas(row.appIdeas),
      ideasGeneratedAt: row.appIdeasGeneratedAt,
      aiConnected: row.aiConnected ?? null,
      completedAt: row.completedAt,
      sessionId: row.sessionId ?? null,
    };
  }

  patch(patch: ProgressPatch): WelcomeProgress {
    const now = new Date().toISOString();
    const existing = this.db
      .select()
      .from(this.tables.progress)
      .where(eq(this.tables.progress.id, SINGLETON_ID))
      .get();

    const next = {
      id: SINGLETON_ID,
      node: patch.node !== undefined ? patch.node : readNode(existing?.node),
      introRawInput:
        patch.introRawInput !== undefined ? patch.introRawInput : (existing?.introRawInput ?? null),
      introSummary:
        patch.introSummary !== undefined ? patch.introSummary : (existing?.introSummary ?? null),
      appIdeas: patch.appIdeas !== undefined ? patch.appIdeas : (existing?.appIdeas ?? null),
      appIdeasGeneratedAt:
        patch.appIdeasGeneratedAt !== undefined
          ? patch.appIdeasGeneratedAt
          : (existing?.appIdeasGeneratedAt ?? null),
      aiConnected:
        patch.aiConnected !== undefined ? patch.aiConnected : (existing?.aiConnected ?? null),
      completedAt:
        patch.completedAt !== undefined ? patch.completedAt : (existing?.completedAt ?? null),
      sessionId: patch.sessionId !== undefined ? patch.sessionId : (existing?.sessionId ?? null),
      updatedAt: now,
    };

    if (existing) {
      this.db
        .update(this.tables.progress)
        .set(next)
        .where(eq(this.tables.progress.id, SINGLETON_ID))
        .run();
    } else {
      this.db.insert(this.tables.progress).values(next).run();
    }

    return {
      node: readNode(next.node),
      introRawInput: next.introRawInput,
      introSummary: next.introSummary,
      ideas: parseIdeas(next.appIdeas),
      ideasGeneratedAt: next.appIdeasGeneratedAt,
      aiConnected: next.aiConnected,
      completedAt: next.completedAt,
      sessionId: next.sessionId,
    };
  }

  /**
   * Wipe the welcome run back to a clean first-contact state: cursor at `greet`
   * and every captured artifact (ChatGPT/interview input, folded summary,
   * brainstormed ideas, completion stamp, chat id) cleared. The landing screen
   * calls this when the guardian starts the welcome, or chooses to start over,
   * so the new chat replays the flow from scratch. Scope is
   * deliberately just this row: memory, settings, and prior transcripts are left
   * untouched.
   */
  reset(): WelcomeProgress {
    return this.patch({
      node: "greet",
      introRawInput: null,
      introSummary: null,
      appIdeas: null,
      appIdeasGeneratedAt: null,
      aiConnected: null,
      completedAt: null,
      sessionId: null,
    });
  }
}

export function createProgressRepository(ctx: AppDbContext): ProgressRepository {
  return new ProgressRepository(ctx.connection, ctx.tablePrefix);
}

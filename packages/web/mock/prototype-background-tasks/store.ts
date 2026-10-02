// PROTOTYPE ONLY. Simulated session state for the webchat background-task UI
// prototype. It stands in for what PR 2 (task events, live list) and PR 3
// (Rome-started turns) would stream; the question here is only what the UI
// should look like, so none of this is production logic.

import { useSyncExternalStore } from "react";

export type TaskStatus = "running" | "completed" | "failed" | "stopped";
export type TaskKind = "shell" | "subagent";

export interface BgTask {
  id: string;
  kind: TaskKind;
  label: string;
  command?: string;
  startedAt: number;
  endedAt?: number;
  status: TaskStatus;
  exitCode?: number;
  /** Why a stopped task stopped. */
  stopReason?: "user" | "idle-cap";
  outputTail: string[];
  /** Whether a Rome-started turn has already reported this task. */
  reported: boolean;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; state: "queued" | "consumed" }
  | { kind: "agent"; id: string; text: string; streaming: boolean; startsTasks?: string[] }
  | { kind: "marker"; id: string; taskIds: string[]; silent: boolean; settled: boolean };

export type Knobs = {
  stopButton: boolean;
  afterTask: "replies" | "may-stay-silent";
  idleCap: "30 min" | "2 h";
};

export interface ProtoState {
  now: number;
  tasks: BgTask[];
  transcript: TranscriptItem[];
  /** What the model is doing right now. */
  turn: "idle" | "user-turn" | "background-turn";
  /** Task ids whose results wait for the current turn to end. */
  queuedResults: string[];
  /** User messages that wait for the current turn to end. */
  queuedUserMessages: string[];
  knobs: Knobs;
  log: string[];
}

const T0 = Date.now();

const OUTPUT: Record<string, string[]> = {
  tests: [
    " ✓ src/core/agent-session.test.ts (212 tests) 4.1s",
    " ✓ src/core/anthropic-provider.test.ts (44 tests) 2.3s",
    " ✓ src/api/routes/webchat.test.ts (96 tests) 3.8s",
    " ✓ src/actions/engine.test.ts (131 tests) 2.9s",
    " ✓ src/db/repositories/sessions.test.ts (58 tests) 1.7s",
  ],
  preview: [
    "  ➜  Local:   http://localhost:4173/",
    "GET /reports/2026-09-27 200 12ms",
    "GET /api/quotes?symbols=SPY,QQQ 200 31ms",
    "GET /reports/2026-09-28 200 9ms",
  ],
  research: [
    "Reading: Fed minutes, September meeting",
    "Reading: Treasury auction results",
    "Drafting summary (3 sources)",
  ],
};

function initialState(knobs?: Knobs): ProtoState {
  const started = T0 - 38_000;
  return {
    now: Date.now(),
    tasks: [
      {
        id: "b7i8swnzp",
        kind: "shell",
        label: "Unit tests",
        command: "pnpm test:unit",
        startedAt: started,
        status: "running",
        outputTail: OUTPUT.tests.slice(0, 2),
        reported: false,
      },
      {
        id: "bq9qakwdi",
        kind: "shell",
        label: "Preview server",
        command: "pnpm preview --port 4173",
        startedAt: started + 1_500,
        status: "running",
        outputTail: OUTPUT.preview.slice(0, 1),
        reported: false,
      },
      {
        id: "ad29225d38f3",
        kind: "subagent",
        label: "Summarize this week's Fed news",
        startedAt: started + 3_000,
        status: "running",
        outputTail: OUTPUT.research.slice(0, 1),
        reported: false,
      },
    ],
    transcript: [
      {
        kind: "user",
        id: "u0",
        text: "Run the unit tests and start the preview server in the background, and have a subagent summarize this week's Fed news. Tell me when the tests finish.",
        state: "consumed",
      },
      {
        kind: "agent",
        id: "a0",
        text: "Started all three in the background: the unit tests (`pnpm test:unit`), the preview server on port 4173, and a subagent summarizing this week's Fed news. I'll tell you as soon as the tests finish.",
        streaming: false,
        startsTasks: ["b7i8swnzp", "bq9qakwdi", "ad29225d38f3"],
      },
    ],
    turn: "idle",
    queuedResults: [],
    queuedUserMessages: [],
    knobs: knobs ?? { stopButton: true, afterTask: "replies", idleCap: "30 min" },
    log: ["idle: 3 background tasks running after the turn ended"],
  };
}

let state = initialState();
const listeners = new Set<() => void>();
let seq = 0;

function set(next: ProtoState, event?: string): void {
  state = event
    ? { ...next, log: [`${new Date().toLocaleTimeString()} ${event}`, ...next.log].slice(0, 40) }
    : next;
  for (const l of listeners) l();
}

function patchTask(id: string, patch: Partial<BgTask>): BgTask[] {
  return state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

function taskById(id: string): BgTask | undefined {
  return state.tasks.find((t) => t.id === id);
}

// ---------------------------------------------------------------- clock + output

let timer: ReturnType<typeof setInterval> | undefined;
function tick(): void {
  const tasks = state.tasks.map((t) => {
    if (t.status !== "running") return t;
    const source =
      t.id === "b7i8swnzp"
        ? OUTPUT.tests
        : t.kind === "subagent"
          ? OUTPUT.research
          : OUTPUT.preview;
    if (Math.random() > 0.35) return t;
    const nextLine = source[(t.outputTail.length + 1) % source.length];
    return { ...t, outputTail: [...t.outputTail, nextLine].slice(-3) };
  });
  set({ ...state, now: Date.now(), tasks });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(tick, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useProto(): ProtoState {
  return useSyncExternalStore(subscribe, () => state);
}

// ---------------------------------------------------------------- turns

function streamAgent(text: string, done: () => void): void {
  const id = `a${++seq}`;
  set({
    ...state,
    transcript: [...state.transcript, { kind: "agent", id, text: "", streaming: true }],
  });
  const words = text.split(" ");
  let i = 0;
  const step = () => {
    i = Math.min(words.length, i + 3);
    set({
      ...state,
      transcript: state.transcript.map((m) =>
        m.id === id && m.kind === "agent"
          ? { ...m, text: words.slice(0, i).join(" "), streaming: i < words.length }
          : m,
      ),
    });
    if (i < words.length) setTimeout(step, 90);
    else done();
  };
  setTimeout(step, 900);
}

function reportText(tasks: BgTask[]): { text: string; worthSaying: boolean } {
  const parts: string[] = [];
  let worthSaying = false;
  for (const t of tasks) {
    if (t.id === "b7i8swnzp" && t.status === "completed") {
      parts.push(
        "The unit tests finished: **4,799 passed** across 405 files in 2m 14s. Nothing failed.",
      );
      worthSaying = true;
    } else if (t.id === "b7i8swnzp" && t.status === "failed") {
      parts.push(
        "The unit tests **failed**: 2 of 4,799 tests broke in `src/core/agent-session.test.ts` (`closes an idle session` and `keeps a session with live tasks`). Want me to look into them?",
      );
      worthSaying = true;
    } else if (t.kind === "subagent" && t.status === "completed") {
      parts.push(
        "The Fed news summary is in: the September minutes lean toward one more cut this year, and last week's Treasury auctions saw soft demand at the long end.",
      );
      worthSaying = true;
    } else if (t.status === "completed") {
      parts.push(`\`${t.command ?? t.label}\` finished cleanly.`);
    }
  }
  return { text: parts.join("\n\n") || "Noted — nothing needs your attention.", worthSaying };
}

function startBackgroundTurn(taskIds: string[]): void {
  const markerId = `m${++seq}`;
  const tasks = taskIds.map(taskById).filter((t): t is BgTask => !!t);
  const { text, worthSaying } = reportText(tasks);
  const silent = state.knobs.afterTask === "may-stay-silent" && !worthSaying;
  set(
    {
      ...state,
      turn: "background-turn",
      queuedResults: state.queuedResults.filter((id) => !taskIds.includes(id)),
      tasks: state.tasks.map((t) => (taskIds.includes(t.id) ? { ...t, reported: true } : t)),
      transcript: [
        ...state.transcript,
        { kind: "marker", id: markerId, taskIds, silent, settled: false },
      ],
    },
    `Rome started a turn for ${tasks.map((t) => t.label).join(", ")} (no user message)`,
  );
  const finish = () => {
    set({
      ...state,
      transcript: state.transcript.map((m) =>
        m.id === markerId && m.kind === "marker" ? { ...m, settled: true } : m,
      ),
    });
    endTurn();
  };
  if (silent) {
    setTimeout(finish, 1400);
  } else {
    streamAgent(text, finish);
  }
}

function startUserTurn(text: string, alreadyShown?: string): void {
  const transcript = alreadyShown
    ? state.transcript.map((m) =>
        m.id === alreadyShown && m.kind === "user" ? { ...m, state: "consumed" as const } : m,
      )
    : [
        ...state.transcript,
        { kind: "user" as const, id: `u${++seq}`, text, state: "consumed" as const },
      ];
  set({ ...state, turn: "user-turn", transcript }, `user turn started: "${text.slice(0, 40)}"`);
  streamAgent(
    text.includes("preview")
      ? "The preview server is still up at http://localhost:4173 — it has served 3 report pages so far."
      : "Here's the quick answer: yes, the report for today is already scheduled for 5 pm, and it will use the numbers from the backfill.",
    endTurn,
  );
}

function endTurn(): void {
  set({ ...state, turn: "idle" }, "turn ended");
  // Queued background results run first: they were waiting longer.
  if (state.queuedResults.length > 0) {
    const ids = state.queuedResults;
    setTimeout(() => startBackgroundTurn(ids), 400);
    return;
  }
  const next = state.queuedUserMessages[0];
  if (next) {
    const msg = state.transcript.find((m) => m.id === next);
    set({ ...state, queuedUserMessages: state.queuedUserMessages.slice(1) });
    if (msg?.kind === "user") setTimeout(() => startUserTurn(msg.text, msg.id), 300);
  }
}

// ---------------------------------------------------------------- scenario actions

export function finishTask(id: string, ok: boolean): void {
  const task = taskById(id);
  if (!task || task.status !== "running") return;
  const tail =
    id === "b7i8swnzp"
      ? ok
        ? [
            " Test Files  405 passed (405)",
            "      Tests  4799 passed (4799)",
            "   Duration  134.2s",
          ]
        : [
            " ✗ src/core/agent-session.test.ts (2 failed)",
            "      Tests  2 failed | 4797 passed (4799)",
            "   Duration  131.8s",
          ]
      : task.kind === "subagent"
        ? ["Summary ready (212 words)"]
        : task.outputTail;
  const tasks = patchTask(id, {
    status: ok ? "completed" : "failed",
    exitCode: task.kind === "shell" ? (ok ? 0 : 1) : undefined,
    endedAt: Date.now(),
    outputTail: tail,
  });
  if (state.turn === "idle") {
    set(
      { ...state, tasks },
      `${task.label} ${ok ? "completed" : "failed"} while idle → Rome starts a turn`,
    );
    setTimeout(() => startBackgroundTurn([id]), 500);
  } else {
    set(
      { ...state, tasks, queuedResults: [...state.queuedResults, id] },
      `${task.label} ${ok ? "completed" : "failed"} during a ${state.turn} → result queued`,
    );
  }
}

export function stopTask(id: string): void {
  const task = taskById(id);
  if (!task || task.status !== "running") return;
  set(
    {
      ...state,
      tasks: patchTask(id, {
        status: "stopped",
        stopReason: "user",
        endedAt: Date.now(),
        reported: true,
      }),
    },
    `${task.label} stopped by the user → no turn; the model hears about it on its next turn`,
  );
}

export function idleCapReached(): void {
  const running = state.tasks.filter((t) => t.status === "running");
  if (running.length === 0) return;
  set(
    {
      ...state,
      tasks: state.tasks.map((t) =>
        t.status === "running"
          ? { ...t, status: "stopped", stopReason: "idle-cap", endedAt: Date.now(), reported: true }
          : t,
      ),
    },
    `idle cap (${state.knobs.idleCap}) reached → ${running.length} task(s) stopped; the model hears about it on its next turn`,
  );
}

export function sendUserMessage(text: string): void {
  if (state.turn === "idle") {
    startUserTurn(text);
    return;
  }
  const id = `u${++seq}`;
  set(
    {
      ...state,
      transcript: [...state.transcript, { kind: "user", id, text, state: "queued" }],
      queuedUserMessages: [...state.queuedUserMessages, id],
    },
    `user message sent during a ${state.turn} → queued`,
  );
}

/** A user message, then the tests finish while Rome is still answering it. */
export function sendThenTestsFinish(): void {
  sendUserMessage("Is today's market report already scheduled?");
  setTimeout(() => finishTask("b7i8swnzp", true), 700);
}

/** The tests finish, then the user sends a message while Rome reports them. */
export function testsFinishThenSend(): void {
  finishTask("b7i8swnzp", true);
  setTimeout(() => sendUserMessage("Is the preview server still up?"), 1200);
}

export function setKnob<K extends keyof Knobs>(key: K, value: Knobs[K]): void {
  set({ ...state, knobs: { ...state.knobs, [key]: value } }, `knob ${key} = ${value}`);
}

export function reset(): void {
  set(initialState(state.knobs), "reset");
}

// ---------------------------------------------------------------- formatting

export function elapsed(task: BgTask, now: number): string {
  const ms = (task.endedAt ?? now) - task.startedAt;
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function statusText(task: BgTask): string {
  switch (task.status) {
    case "running":
      return "Running";
    case "completed":
      return task.exitCode === undefined ? "Done" : `Done · exit ${task.exitCode}`;
    case "failed":
      return task.exitCode === undefined ? "Failed" : `Failed · exit ${task.exitCode}`;
    case "stopped":
      return task.stopReason === "idle-cap" ? "Stopped · chat idle too long" : "Stopped";
  }
}

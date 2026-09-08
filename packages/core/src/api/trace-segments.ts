import type {
  AppRefDto,
  SubagentResultBlock,
  SubagentStartBlock,
  ToolUseBlock,
  ToolResultBlock,
  TerminalTraceBlock,
  TraceBlockDto,
  TraceRunSegment,
  TraceSegment,
  TraceSnapshot,
  TraceSummary,
} from "@rome/api-types/trace-segments";
import { turnTerminalError } from "@rome/api-types/trace-segments";
import { toTraceBlock, type TraceableAgentMessage } from "./helpers.js";
import { isTerminalBlock } from "../core/agent-message.js";

export type {
  AppRefDto,
  SubagentResultBlock,
  SubagentStartBlock,
  ToolUseBlock,
  ToolResultBlock,
  TraceBlockDto,
  TraceRunSegment,
  TraceSegment,
  TraceSnapshot,
  TraceSummary,
};

export interface AppResolver {
  /** Resolve the App that owns a given tool invocation. */
  resolveTool(block: ToolUseBlock | SubagentStartBlock): AppRefDto;
}

type InvocationStartBlock = ToolUseBlock | SubagentStartBlock;
type InvocationResultBlock = ToolResultBlock | SubagentResultBlock;

interface RunState {
  segId: string;
  app: AppRefDto;
  ordinal: number;
  count: number;
  /** Live, mutable block list. Snapshots are sliced before leaving the builder. */
  blocks: TraceBlockDto[];
  pairedAny: boolean;
  /** Once any paired step lacked timestamps, the run's duration becomes
   *  permanently unknown. */
  durationDirty: boolean;
  /** Sum of paired step durations. Only meaningful when pairedAny && !durationDirty. */
  durationMs: number;
  /** Provider tool-use ID → block index in `blocks`. Updated when a start is appended
   *  or when an earlier-than-end result is spliced in (later positions shift). */
  useIndexById: Map<string, number>;
}

function pairedDurationMs(
  use: InvocationStartBlock,
  result: InvocationResultBlock | undefined,
): number | null {
  if (!result) return null;
  if (!use.startedAt || !result.endedAt) return null;
  const start = Date.parse(use.startedAt);
  const end = Date.parse(result.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function runSegmentFromState(s: RunState): TraceRunSegment {
  return {
    kind: "run",
    id: s.segId,
    app: s.app,
    count: s.count,
    blocks: s.blocks.slice(),
    durationMs: s.pairedAny && !s.durationDirty ? s.durationMs : undefined,
    ordinal: s.ordinal,
  };
}

export interface SegmentBuilder {
  /** Append a block (live SSE) and return the segments whose payload changed. */
  push(block: TraceBlockDto): TraceSegment[];
  /** Snapshot the full ordered segment list and aggregate summary. */
  snapshot(): TraceSnapshot;
}

interface SegmentBuilderArgs {
  /** Used to namespace segment ids so live ids never collide with reload ids. */
  idPrefix: string;
  resolver: AppResolver;
}

export function createSegmentBuilder(args: SegmentBuilderArgs): SegmentBuilder {
  const { idPrefix, resolver } = args;
  const segments: TraceSegment[] = [];
  /** All run states (active and finalized), keyed by segId. We mutate these
   *  freely; segments[] holds frozen snapshots produced via runSegmentFromState. */
  const runs = new Map<string, RunState>();
  /** Segment id of the run currently accepting new tool_uses, or null. Tool_uses
   *  open or extend this run; non-tool blocks reset it to null. */
  let activeRunSegId: string | null = null;
  /** tool_use_id → segId; lets a tool_result pair into any run, including ones
   *  the current `activeRunSegId` has already moved past. */
  const useToRun = new Map<string, string>();
  let nextOrdinal = 0;
  let nextSegmentNum = 0;

  const allocId = () => `${idPrefix}-${nextSegmentNum++}`;

  const distinctApps: AppRefDto[] = [];
  const seenAppIds = new Set<string>();
  const invocationCounts: Record<string, number> = {};
  let totalSteps = 0;
  const subagents: TraceSummary["subagents"] = [];
  const subagentByUseId = new Map<string, NonNullable<TraceSummary["subagents"]>[number]>();
  let totalDurationMs: number | undefined;
  let turnStatus: TraceSummary["turnStatus"];
  // Turn outcome comes from turn_end, not provider transport completion.
  let stoppedByUser = false;
  let terminalError: string | undefined;
  let latestPlan: TraceSummary["plan"];
  /** Most recent result/error block; the turn's own `turn_end` reads it to
   *  derive the summary (stop/error state). */
  let lastTerminal: TerminalTraceBlock | undefined;

  const observeApp = (app: AppRefDto) => {
    if (!seenAppIds.has(app.id)) {
      seenAppIds.add(app.id);
      distinctApps.push(app);
    }
    invocationCounts[app.id] = (invocationCounts[app.id] ?? 0) + 1;
  };

  const findSegmentIndex = (id: string): number => segments.findIndex((s) => s.id === id);

  const upsertRunSegment = (state: RunState): TraceRunSegment => {
    const seg = runSegmentFromState(state);
    const idx = findSegmentIndex(seg.id);
    if (idx >= 0) segments[idx] = seg;
    else segments.push(seg);
    return seg;
  };

  const applyPairing = (state: RunState, useIdx: number, result: InvocationResultBlock): void => {
    state.blocks.splice(useIdx + 1, 0, result);
    for (const [otherId, otherIdx] of state.useIndexById) {
      if (otherIdx > useIdx) state.useIndexById.set(otherId, otherIdx + 1);
    }
    const use = state.blocks[useIdx];
    const stepDuration =
      use.type === "tool_use" || use.type === "subagent_start"
        ? pairedDurationMs(use, result)
        : null;
    state.pairedAny = true;
    if (stepDuration === null) {
      state.durationDirty = true;
    } else {
      state.durationMs += stepDuration;
    }
  };

  /** Fallback for a result with no tool-use id: pairs it with the most recent
   *  unpaired same-name tool_use in the active run. */
  const fallbackPairIntoActive = (result: ToolResultBlock): TraceRunSegment | null => {
    if (!activeRunSegId) return null;
    const state = runs.get(activeRunSegId);
    if (!state) return null;
    const tool = result.tool;
    let useIdx = -1;
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const b = state.blocks[i];
      if (b.type !== "tool_use" || b.tool !== tool) continue;
      const next = state.blocks[i + 1];
      if (next && next.type === "tool_result") continue;
      useIdx = i;
      break;
    }
    if (useIdx < 0) return null;
    applyPairing(state, useIdx, result);
    return upsertRunSegment(state);
  };

  return {
    push(block: TraceBlockDto): TraceSegment[] {
      const changed: TraceSegment[] = [];

      // Lifecycle blocks carry boundary metadata for the summary; they render
      // nothing, so they never become segments.
      if (block.type === "turn_start") {
        activeRunSegId = null;
        // The summary's terminal state is turn-scoped: a new turn must not
        // keep reporting the previous turn's error/stopped pill (or its
        // duration) while it is still running.
        totalDurationMs = undefined;
        turnStatus = undefined;
        stoppedByUser = false;
        terminalError = undefined;
        latestPlan = undefined;
        lastTerminal = undefined;
        return changed;
      }
      if (block.type === "turn_end") {
        activeRunSegId = null;
        totalDurationMs = block.durationMs;
        turnStatus = block.status;
        // `turn_end.status` is the authoritative turn outcome; the bracketed
        // terminal (most recent same-agent result/error — sub-agent terminals
        // relay tagged with their own agent name) only supplies the error
        // message. Both fields are re-derived from scratch each turn so one
        // interrupted turn doesn't leave `stoppedByUser` sticky for the turns
        // that follow it.
        stoppedByUser = block.status === "interrupted";
        terminalError = turnTerminalError(lastTerminal, block.status) ?? undefined;
        lastTerminal = undefined;
        return changed;
      }

      // Plans are replaceable turn summary state, not timeline segments. They
      // deliberately leave the active tool run open so a provider update that
      // lands during a tool call does not split otherwise-adjacent tool steps.
      if (block.type === "plan_update") {
        latestPlan = {
          ...(block.plan.explanation ? { explanation: block.plan.explanation } : {}),
          steps: block.plan.steps.map((step) => ({ ...step })),
        };
        return changed;
      }

      if (block.type === "tool_result" || block.type === "subagent_result") {
        if (block.type === "subagent_result") {
          const subagent = subagentByUseId.get(block.toolUseId);
          if (subagent) subagent.status = block.status;
        }
        // Preferred path: pair by provider tool-use ID into whichever run owns it,
        // even if that run is no longer active.
        const tuid = block.toolUseId;
        if (tuid) {
          const segId = useToRun.get(tuid);
          const state = segId ? runs.get(segId) : undefined;
          const useIdx = state?.useIndexById.get(tuid);
          if (state && useIdx !== undefined) {
            const after = state.blocks[useIdx + 1];
            if (after && (after.type === "tool_result" || after.type === "subagent_result")) {
              return changed;
            }
            applyPairing(state, useIdx, block);
            const seg = upsertRunSegment(state);
            changed.push(seg);
            return changed;
          }
          // tuid present but no matching use — drop.
          return changed;
        }
        const seg = block.type === "tool_result" ? fallbackPairIntoActive(block) : null;
        if (seg) changed.push(seg);
        return changed;
      }

      if (block.type !== "tool_use" && block.type !== "subagent_start") {
        // Non-tool block ends the active run (further tool_uses open a new one),
        // but the run's RunState lives on so a late tool_result can still pair
        // by id.
        activeRunSegId = null;
        if (isTerminalBlock(block)) {
          lastTerminal = block;
        }
        const seg: TraceSegment = {
          kind: "block",
          id: allocId(),
          block,
          ordinal: nextOrdinal++,
        };
        segments.push(seg);
        changed.push(seg);
        return changed;
      }

      // Invocation start: extend or open a run.
      const app = resolver.resolveTool(block);
      observeApp(app);
      totalSteps += 1;
      if (block.type === "subagent_start") {
        if (!subagentByUseId.has(block.toolUseId)) {
          const subagent = {
            toolUseId: block.toolUseId,
            agentName: block.agentName,
            sessionId: block.sessionId,
            turnId: block.turnId,
            status: "running" as const,
          };
          subagents.push(subagent);
          subagentByUseId.set(block.toolUseId, subagent);
        }
      }

      const active = activeRunSegId ? (runs.get(activeRunSegId) ?? null) : null;
      if (active && active.app.id === app.id) {
        active.count += 1;
        const idx = active.blocks.length;
        active.blocks.push(block);
        const useId = block.type === "tool_use" ? block.id : block.toolUseId;
        if (useId) {
          active.useIndexById.set(useId, idx);
          useToRun.set(useId, active.segId);
        }
        const seg = upsertRunSegment(active);
        changed.push(seg);
        return changed;
      }

      const segId = allocId();
      const state: RunState = {
        segId,
        app,
        ordinal: nextOrdinal++,
        count: 1,
        blocks: [block],
        pairedAny: false,
        durationDirty: false,
        durationMs: 0,
        useIndexById: new Map(),
      };
      const useId = block.type === "tool_use" ? block.id : block.toolUseId;
      if (useId) {
        state.useIndexById.set(useId, 0);
        useToRun.set(useId, segId);
      }
      runs.set(segId, state);
      activeRunSegId = segId;
      const seg = upsertRunSegment(state);
      changed.push(seg);
      return changed;
    },

    snapshot(): TraceSnapshot {
      return {
        segments: segments.map((s) => (s.kind === "run" ? { ...s, blocks: s.blocks.slice() } : s)),
        summary: {
          distinctApps: distinctApps.slice(),
          totalSteps,
          ...(subagents.length > 0
            ? { subagents: subagents.map((subagent) => ({ ...subagent })) }
            : {}),
          totalDurationMs,
          turnStatus,
          invocationCounts: { ...invocationCounts },
          ...(stoppedByUser ? { stoppedByUser: true } : {}),
          ...(terminalError ? { terminalError } : {}),
          ...(latestPlan
            ? {
                plan: {
                  ...(latestPlan.explanation ? { explanation: latestPlan.explanation } : {}),
                  steps: latestPlan.steps.map((step) => ({ ...step })),
                },
              }
            : {}),
        },
      };
    },
  };
}

export interface BuildTraceSnapshotArgs {
  /** Stable id namespace; segment ids are `${idPrefix}-N`. */
  idPrefix: string;
  blocks: TraceBlockDto[];
  resolver: AppResolver;
}

/** Project a persisted block list to a snapshot. Used by the read endpoint. */
export function buildTraceSnapshot(args: BuildTraceSnapshotArgs): TraceSnapshot {
  const builder = createSegmentBuilder({
    idPrefix: args.idPrefix,
    resolver: args.resolver,
  });
  for (const block of args.blocks) {
    builder.push(block);
  }
  return builder.snapshot();
}

/** Convenience for the SSE wiring: project an AgentMessage to a TraceBlockDto
 *  using the same shape persisted on disk. Transient `text_delta` previews
 *  have no block representation and are excluded at the type level. */
export function agentMessageToBlock(
  msg: TraceableAgentMessage & { agent?: string },
): TraceBlockDto {
  return toTraceBlock(msg);
}

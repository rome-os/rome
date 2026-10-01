import { resolvePortableToolApp } from "./builtin-apps.js";
import type {
  AgentDisplayNameResolver,
  AppRefDto,
  AppResolver,
  ToolResultBlock,
  ToolUseBlock,
  ErrorEvent,
  ResultEvent,
  TraceEventDto,
  TraceRunSegment,
  TraceSegment,
  TraceSnapshot,
} from "./types.js";

interface RunState {
  segId: string;
  agent: string;
  agentDisplayName: string;
  app: AppRefDto;
  ordinal: number;
  count: number;
  blocks: TraceEventDto[];
  pairedAny: boolean;
  durationDirty: boolean;
  durationMs: number;
  useIndexById: Map<string, number>;
}

function isTerminalEvent(block: TraceEventDto): block is ResultEvent | ErrorEvent {
  return block.type === "result" || block.type === "error";
}

function pairedDurationMs(
  toolUse: ToolUseBlock,
  toolResult: ToolResultBlock | undefined,
): number | null {
  if (!toolResult) return null;
  if (!toolUse.startedAt || !toolResult.endedAt) return null;
  const start = Date.parse(toolUse.startedAt);
  const end = Date.parse(toolResult.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function runSegmentFromState(s: RunState): TraceRunSegment {
  return {
    kind: "run",
    id: s.segId,
    agent: s.agent,
    agentDisplayName: s.agentDisplayName,
    app: s.app,
    count: s.count,
    blocks: s.blocks.slice(),
    durationMs: s.pairedAny && !s.durationDirty ? s.durationMs : undefined,
    ordinal: s.ordinal,
  };
}

function defaultAgentDisplayName(agentId: string): string {
  if (!agentId || agentId === "main") return "Rome";
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

export interface BuildTraceSnapshotArgs {
  idPrefix: string;
  blocks: TraceEventDto[];
  resolver?: AppResolver;
  agentDisplayName?: AgentDisplayNameResolver;
}

export function buildTraceSnapshot(args: BuildTraceSnapshotArgs): TraceSnapshot {
  const resolver = args.resolver ?? { resolveTool: resolvePortableToolApp };
  const agentDisplayName = args.agentDisplayName ?? defaultAgentDisplayName;
  const segments: TraceSegment[] = [];
  const runs = new Map<string, RunState>();
  const useToRun = new Map<string, string>();
  const distinctApps: AppRefDto[] = [];
  const seenAppIds = new Set<string>();
  const invocationCounts: Record<string, number> = {};
  let activeRunSegId: string | null = null;
  let nextOrdinal = 0;
  let nextSegmentNum = 0;
  let totalSteps = 0;
  let totalDurationMs: number | undefined;
  let stoppedByUser = false;
  let terminalError: string | undefined;
  let lastTerminal: (TraceEventDto & { type: "result" | "error" }) | undefined;

  const allocId = () => `${args.idPrefix}-${nextSegmentNum++}`;
  const observeApp = (app: AppRefDto) => {
    if (!seenAppIds.has(app.id)) {
      seenAppIds.add(app.id);
      distinctApps.push(app);
    }
    invocationCounts[app.id] = (invocationCounts[app.id] ?? 0) + 1;
  };
  const upsertRunSegment = (state: RunState) => {
    const seg = runSegmentFromState(state);
    const idx = segments.findIndex((s) => s.id === seg.id);
    if (idx >= 0) segments[idx] = seg;
    else segments.push(seg);
    return seg;
  };
  const applyPairing = (state: RunState, useIdx: number, result: ToolResultBlock): void => {
    state.blocks.splice(useIdx + 1, 0, result);
    for (const [otherId, otherIdx] of state.useIndexById) {
      if (otherIdx > useIdx) state.useIndexById.set(otherId, otherIdx + 1);
    }
    const use = state.blocks[useIdx];
    const toolCallDuration = use.type === "tool_use" ? pairedDurationMs(use, result) : null;
    state.pairedAny = true;
    if (toolCallDuration === null) state.durationDirty = true;
    else state.durationMs += toolCallDuration;
  };
  const fallbackPairIntoActive = (result: ToolResultBlock, agent: string): boolean => {
    if (!activeRunSegId) return false;
    const state = runs.get(activeRunSegId);
    if (!state || state.agent !== agent) return false;
    let useIdx = -1;
    for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
      const b = state.blocks[i];
      if (b.type !== "tool_use" || b.tool !== result.tool) continue;
      const next = state.blocks[i + 1];
      if (next && next.type === "tool_result") continue;
      useIdx = i;
      break;
    }
    if (useIdx < 0) return false;
    applyPairing(state, useIdx, result);
    upsertRunSegment(state);
    return true;
  };

  for (const block of args.blocks) {
    const agent = block.agent ?? "main";
    const displayName = agentDisplayName(agent);

    // Lifecycle blocks update the summary only — they never render.
    if (block.type === "turn_start") {
      activeRunSegId = null;
      // Terminal summary state is turn-scoped: a new turn clears the
      // previous turn's error/stopped pill and duration.
      totalDurationMs = undefined;
      stoppedByUser = false;
      terminalError = undefined;
      lastTerminal = undefined;
      continue;
    }
    if (block.type === "turn_end") {
      activeRunSegId = null;
      totalDurationMs = block.durationMs;
      // `turn_end.status` is the authoritative outcome; the bracketed
      // same-agent terminal only supplies the error message. Re-derived from
      // scratch each turn so one interrupted turn doesn't leave
      // `stoppedByUser` sticky for the turns that follow it.
      stoppedByUser = block.status === "interrupted";
      terminalError =
        block.status === "error" &&
        lastTerminal &&
        (lastTerminal.agent ?? "main") === agent &&
        lastTerminal.type === "error"
          ? lastTerminal.error
          : undefined;
      lastTerminal = undefined;
      continue;
    }

    if (block.type === "tool_result") {
      if (block.toolUseId) {
        const segId = useToRun.get(block.toolUseId);
        const state = segId ? runs.get(segId) : undefined;
        const useIdx = state?.useIndexById.get(block.toolUseId);
        if (state && useIdx !== undefined) {
          const after = state.blocks[useIdx + 1];
          if (!after || after.type !== "tool_result") {
            applyPairing(state, useIdx, block);
            upsertRunSegment(state);
          }
        }
        continue;
      }
      fallbackPairIntoActive(block, agent);
      continue;
    }

    if (block.type !== "tool_use") {
      activeRunSegId = null;
      if (isTerminalEvent(block)) {
        lastTerminal = block;
      }
      segments.push({
        kind: "block",
        id: allocId(),
        agent,
        agentDisplayName: displayName,
        block,
        ordinal: nextOrdinal++,
      });
      continue;
    }

    const app = resolver.resolveTool(block);
    observeApp(app);
    totalSteps += 1;

    const active = activeRunSegId ? (runs.get(activeRunSegId) ?? null) : null;
    if (active && active.app.id === app.id && active.agent === agent) {
      active.count += 1;
      const idx = active.blocks.length;
      active.blocks.push(block);
      if (block.id) {
        active.useIndexById.set(block.id, idx);
        useToRun.set(block.id, active.segId);
      }
      upsertRunSegment(active);
      continue;
    }

    const segId = allocId();
    const state: RunState = {
      segId,
      agent,
      agentDisplayName: displayName,
      app,
      ordinal: nextOrdinal++,
      count: 1,
      blocks: [block],
      pairedAny: false,
      durationDirty: false,
      durationMs: 0,
      useIndexById: new Map(),
    };
    if (block.id) {
      state.useIndexById.set(block.id, 0);
      useToRun.set(block.id, segId);
    }
    runs.set(segId, state);
    activeRunSegId = segId;
    upsertRunSegment(state);
  }

  segments.sort((a, b) => a.ordinal - b.ordinal);

  return {
    segments,
    summary: {
      distinctApps,
      totalSteps,
      totalDurationMs,
      invocationCounts,
      stoppedByUser: stoppedByUser || undefined,
      terminalError,
    },
  };
}

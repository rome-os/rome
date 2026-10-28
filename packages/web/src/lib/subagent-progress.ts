import type { TraceEventDto, TraceSegment } from "@rome/api-types/trace-segments";
import { artifactLocalName } from "@/lib/artifact-name";
import { describeToolSummary } from "@/components/chat/entries/ToolCallView";

function segmentBlocks(segment: TraceSegment): TraceEventDto[] {
  return segment.kind === "run" ? segment.blocks : [segment.block];
}

/**
 * Names the most recent tool call in a running trace, such as `Bash pnpm test`,
 * or null before the first call. The streaming order of segments is the time
 * order, so the last call of the last segment that holds one is the newest.
 */
export function describeLatestStep(segments: readonly TraceSegment[]): string | null {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const blocks = segmentBlocks(segments[i]);
    for (let j = blocks.length - 1; j >= 0; j -= 1) {
      const block = blocks[j];
      if (block.type === "tool_use") {
        const label = artifactLocalName(block.tool);
        const detail = describeToolSummary(block.tool, block.input, undefined, false, (k) => k);
        return detail ? `${label} ${detail}` : label;
      }
      if (block.type === "subagent_start") return artifactLocalName(block.agentName);
    }
  }
  return null;
}

/** Start time of the earliest timestamped call, or null when none carries one. */
export function firstStepStartMs(segments: readonly TraceSegment[]): number | null {
  let earliest: number | null = null;
  for (const segment of segments) {
    for (const block of segmentBlocks(segment)) {
      if (block.type !== "tool_use" && block.type !== "subagent_start") continue;
      const at = block.startedAt ? Date.parse(block.startedAt) : Number.NaN;
      if (Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

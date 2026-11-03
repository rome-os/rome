import type { TraceSegment } from "@rome/api-types/trace-segments";

/** A hand-driven `/api/chat/turns/:id/stream` response for tests. */
export class FakeTurnStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  readonly response: Response;

  constructor() {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.response = new Response(body, { status: 200 });
  }

  send(event: string, data: unknown): void {
    this.controller.enqueue(
      this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  close(): void {
    this.controller.close();
  }
}

/** A run segment holding `tools` as in-flight calls of one app. */
export function runSegment(
  id: string,
  tools: { tool: string; input: unknown; startedAt?: string }[],
): TraceSegment {
  return {
    kind: "run",
    id,
    ordinal: 0,
    count: tools.length,
    app: { id: "coding", name: "Coding", iconUrl: "/icon" },
    blocks: tools.map((call, i) => ({
      type: "tool_use" as const,
      id: `${id}-${i}`,
      tool: call.tool,
      input: call.input,
      startedAt: call.startedAt,
    })),
  };
}

export function stepsSummary(totalSteps: number) {
  return { distinctApps: [], totalSteps, invocationCounts: {} };
}

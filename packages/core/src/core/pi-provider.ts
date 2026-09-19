import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type FileEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentAccounting } from "../types.js";
import { getProfileDir } from "../paths.js";
import { createLogger } from "../logger.js";
import { createRomeMcpServerForSession, type RomeMcpGroup } from "./mcp/server.js";
import type {
  ModelProvider,
  ModelSession,
  ModelSessionFork,
  ModelSessionForkMode,
  ModelSessionForkOpenParams,
  ModelSessionForkParams,
  ModelSessionParams,
  ModelUserInput,
  ProviderId,
} from "./agent-runner.js";
import { parseQualifiedPiModelId } from "./pi-model.js";
import { PiRuntimeManager } from "./pi-runtime.js";

const log = createLogger("pi-provider");

// The facade tool groups Rome exposes to a model session, enumerated so the Pi
// binding advertises exactly the same catalog as Codex's dynamic tools.
const PI_TOOL_GROUPS: readonly RomeMcpGroup[] = [
  "actions",
  "subagents",
  "skills",
  "output",
  "ask_user",
];

const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;

export interface PiSessionStore {
  load(sessionId: string): Promise<FileEntry[]>;
  save(sessionId: string, entries: FileEntry[]): Promise<void>;
}

/** Pi's SDK stays in-memory. Rome persists the opaque execution cache under
 * its own profile so Pi's user-facing session archive is never created. */
export class FilePiSessionStore implements PiSessionStore {
  constructor(private readonly root = join(getProfileDir(), "provider-state", "pi")) {}

  private path(sessionId: string): string {
    return join(this.root, `${encodeURIComponent(sessionId)}.json`);
  }

  async load(sessionId: string): Promise<FileEntry[]> {
    try {
      const raw = await readFile(this.path(sessionId), "utf8");
      if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES)
        throw new Error("Pi session cache is too large");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as FileEntry[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(sessionId: string, entries: FileEntry[]): Promise<void> {
    const raw = JSON.stringify(entries);
    if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES)
      throw new Error("Pi session cache is too large");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(sessionId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

class MessageSink {
  private readonly values: AgentMessage[] = [];
  private readonly readers: Array<(result: IteratorResult<AgentMessage>) => void> = [];
  private closed = false;

  readonly events: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return await new Promise<IteratorResult<AgentMessage>>((resolve) =>
          this.readers.push(resolve),
        );
      },
    }),
  };

  push(value: AgentMessage): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined as never, done: true });
  }
}

export function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    // JSON.stringify(undefined) is `undefined`, not a string — fall back so the
    // declared `: string` return type always holds.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function createPiTools(params: ModelSessionForkOpenParams): ToolDefinition[] {
  // Route through the single session-params → facade mapping so a new facade
  // capability can't reach Anthropic/Codex yet silently skip Pi (the invariant
  // documented on createRomeMcpServerForSession); this mirrors how
  // codex/rome-dynamic-tools.ts enumerates the same groups.
  const server = createRomeMcpServerForSession(params);
  return PI_TOOL_GROUPS.flatMap((group) =>
    server.listTools(group).map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      promptSnippet: tool.description,
      // Pi accepts JSON Schema here. ToolDefinition spells the same value as a
      // TypeBox schema so SDK callers get inference; Rome's schemas are dynamic.
      parameters: tool.inputSchema as ToolDefinition["parameters"],
      execute: async (toolCallId, input) => {
        const result = await server.callTool(group, tool.name, input as Record<string, unknown>, {
          toolUseId: toolCallId,
        });
        // Return a facade error to the model as readable content — the way Codex
        // surfaces it as success:false content — instead of throwing, so the
        // model can read the corrective message and retry rather than having the
        // tool call fail opaquely.
        const content =
          result.isError && result.content.length === 0
            ? [{ type: "text" as const, text: `${tool.name} failed` }]
            : result.content;
        return { content, details: {} };
      },
    })),
  );
}

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

async function loadImages(paths: string[] | undefined) {
  return await Promise.all(
    (paths ?? []).map(async (path) => ({
      type: "image" as const,
      data: (await readFile(path)).toString("base64"),
      mimeType: imageMimeType(path),
    })),
  );
}

export type PiAssistantMessage = {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  >;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
  stopReason: string;
  errorMessage?: string;
};

function isAssistantMessage(value: unknown): value is PiAssistantMessage {
  return !!value && typeof value === "object" && (value as { role?: unknown }).role === "assistant";
}

function assistantText(message: PiAssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function turnAccounting(messages: PiAssistantMessage[], model: string): AgentAccounting {
  return {
    provider: "pi",
    model,
    usage: {
      inputTokens: messages.reduce((total, message) => total + message.usage.input, 0),
      outputTokens: messages.reduce((total, message) => total + message.usage.output, 0),
      cacheReadTokens: messages.reduce((total, message) => total + message.usage.cacheRead, 0),
      cacheWriteTokens: messages.reduce((total, message) => total + message.usage.cacheWrite, 0),
    },
    costUsd: messages.reduce((total, message) => total + message.usage.cost.total, 0),
    numTurns: messages.length,
    stopReason: messages.at(-1)?.stopReason,
  };
}

export function finalResult(
  messages: PiAssistantMessage[],
  model: string,
  outputSchema: Record<string, unknown> | undefined,
): AgentMessage {
  const last = messages.at(-1);
  const accounting = turnAccounting(messages, model);
  if (!last)
    return { type: "error", error: "Pi completed without an assistant response", accounting };
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    return {
      type: "error",
      error:
        last.stopReason === "aborted"
          ? "Pi turn was cancelled"
          : "Pi turn failed. Retry, or open Pi in Terminal to repair its configuration.",
      accounting,
    };
  }
  const content = assistantText(last);
  if (!outputSchema) return { type: "result", content, accounting };
  try {
    return { type: "result", content, structuredOutput: JSON.parse(content), accounting };
  } catch {
    return { type: "result", content, accounting };
  }
}

export interface PiEventHandlers {
  /** Emit a Rome AgentMessage into the session stream. */
  pushMessage: (message: AgentMessage) => void;
  /** Record a completed Pi assistant message for turn accounting. */
  collectAssistant: (message: PiAssistantMessage) => void;
}

/**
 * Translate one Pi `AgentSessionEvent` into Rome `AgentMessage`s. Pure and
 * exported so the streaming translation — the piece validated only against the
 * SDK's `.d.ts` shapes — is unit-testable with scripted events.
 */
export function translatePiSessionEvent(event: AgentSessionEvent, handlers: PiEventHandlers): void {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      handlers.pushMessage({ type: "text_delta", content: update.delta });
    }
    return;
  }
  if (event.type === "message_end" && isAssistantMessage(event.message)) {
    handlers.collectAssistant(event.message);
    const hasToolCall = event.message.content.some((part) => part.type === "toolCall");
    for (const part of event.message.content) {
      if (part.type === "text" && part.text) {
        handlers.pushMessage({
          type: "text",
          content: part.text,
          turnPhase: hasToolCall ? "commentary" : "final",
        });
      } else if (part.type === "thinking" && part.thinking) {
        handlers.pushMessage({ type: "thinking", content: part.thinking });
      }
    }
    return;
  }
  if (event.type === "tool_execution_start") {
    handlers.pushMessage({
      type: "tool_use",
      id: event.toolCallId,
      tool: event.toolName,
      input: event.args,
      startedAt: new Date().toISOString(),
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    handlers.pushMessage({
      type: "tool_result",
      toolUseId: event.toolCallId,
      tool: event.toolName,
      output: serializeToolOutput(event.result?.content ?? event.result),
      endedAt: new Date().toISOString(),
    });
  }
}

/**
 * Compute the transcript prefix a fork inherits. Exported and pure so the
 * fail-closed rule is directly testable:
 * - no checkpoint → fork the current head (all entries);
 * - a known checkpoint → the prefix up to and including it;
 * - an unknown checkpoint → throw, rather than silently forking the whole head
 *   (which would leak turns written after the requested point).
 */
export function forkEntriesForCheckpoint(
  allEntries: FileEntry[],
  checkpoint: string | undefined,
): FileEntry[] {
  if (checkpoint === undefined) return allEntries.slice();
  const checkpointIndex = allEntries.findIndex((entry) => entry.id === checkpoint);
  if (checkpointIndex < 0) {
    throw new Error("Pi fork source checkpoint is unavailable");
  }
  return allEntries.slice(0, checkpointIndex + 1);
}

function piSystemPrompt(params: ModelSessionParams): string {
  if (!params.outputSchema) return params.systemPrompt;
  return `${params.systemPrompt}\n\nYour final answer must be only JSON matching this schema:\n${JSON.stringify(params.outputSchema)}`;
}

export interface PiProviderOptions {
  runtime: PiRuntimeManager;
  store?: PiSessionStore;
}

export class PiProvider implements ModelProvider {
  readonly id: ProviderId = "pi";
  readonly displayName = "Pi Coding Agent";
  readonly builtinTools: ReadonlySet<string> = new Set();
  private readonly store: PiSessionStore;

  constructor(private readonly options: PiProviderOptions) {
    this.store = options.store ?? new FilePiSessionStore();
  }

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    const storedEntries =
      params.isNewSession === false && params.providerThreadId
        ? await this.store.load(params.providerThreadId)
        : [];
    return await this.openSessionWithEntries(params, storedEntries);
  }

  private async openSessionWithEntries(
    params: ModelSessionParams,
    entries: FileEntry[],
    // Ephemeral forks (edit-and-resubmit previews) must not leave a transcript
    // file behind, so their execution is never persisted.
    persist = true,
  ): Promise<ModelSession> {
    const selected = this.options.runtime.resolveAvailableModel(params.model);
    if (!selected || !parseQualifiedPiModelId(params.model)) {
      throw new Error(`Selected Pi model is unavailable: ${params.model}`);
    }

    const cwd = params.workingDir ?? process.cwd();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: join(getProfileDir(), "provider-state", "pi-resources-disabled"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: piSystemPrompt(params),
    });
    await resourceLoader.reload();

    const piSessionManager = PiSessionManager.inMemory(cwd, { id: params.sessionId }, entries);
    const customTools = createPiTools(params);
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: selected.runtime as never,
      model: selected.model,
      thinkingLevel: params.reasoningEffort,
      noTools: "all",
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader,
      sessionManager: piSessionManager,
      settingsManager,
    });

    const sink = new MessageSink();
    let closed = false;
    let running = false;
    let lastCompletedTurnCheckpoint: string | undefined;
    let activeTurnMessages: PiAssistantMessage[] = [];

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (closed) return;
      translatePiSessionEvent(event, {
        pushMessage: (message) => sink.push(message),
        collectAssistant: (message) => activeTurnMessages.push(message),
      });
    });

    const runPrompt = async (input: ModelUserInput): Promise<void> => {
      try {
        activeTurnMessages = [];
        // Honor a per-turn reasoning-effort override. Rome's low|high|xhigh are
        // all valid Pi thinking levels, so no mapping is required.
        if (input.reasoningEffort && input.reasoningEffort !== session.thinkingLevel) {
          session.setThinkingLevel(input.reasoningEffort);
        }
        const prompt = input.injectedToolResult
          ? `[Rome tool result for ${input.injectedToolResult.toolUseId}]\n${serializeToolOutput(input.injectedToolResult.content)}\n\n${input.text}`
          : input.text;
        await session.prompt(prompt, {
          images: await loadImages(input.images),
          expandPromptTemplates: false,
          source: "rpc",
        });
        if (persist) await this.store.save(params.sessionId, piSessionManager.getEntries());
        // undefined (not a fake UUID) when Pi reports no leaf, so a later fork
        // that receives it fails closed instead of matching nothing.
        lastCompletedTurnCheckpoint = piSessionManager.getLeafId() ?? undefined;
        sink.push(finalResult(activeTurnMessages, params.model, params.outputSchema));
      } catch (error) {
        // Log for field debugging; the SDK/provider exception can carry request
        // metadata, so the guardian-facing message stays sanitized and retryable.
        log.warn("pi turn failed", {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        sink.push({
          type: "error",
          error: "Pi turn failed. Retry, or open Pi in your terminal to repair its configuration.",
          // Attribute the failed turn to Pi like the finalResult error path does.
          accounting: turnAccounting(activeTurnMessages, params.model),
        });
      } finally {
        running = false;
      }
    };

    const provider = this;
    const modelSession: ModelSession = {
      providerId: this.id,
      model: params.model,
      events: sink.events,
      providerThreadId: params.sessionId,
      get isClosed() {
        return closed;
      },
      get lastCompletedTurnCheckpoint() {
        return lastCompletedTurnCheckpoint;
      },
      async sendUserInput(input) {
        if (closed) throw new Error("ModelSession is closed");
        if (running) throw new Error("Pi is already running a turn");
        running = true;
        void runPrompt(input);
      },
      async steerUserInput(input) {
        if (closed) throw new Error("ModelSession is closed");
        if (!running || input.injectedToolResult) return "deferred";
        // A steer that changes reasoning effort must reopen the session (as
        // Anthropic and Codex do); Pi's thinking level is session-scoped.
        if (input.reasoningEffort && input.reasoningEffort !== session.thinkingLevel) {
          return "deferred";
        }
        await session.steer(input.text, await loadImages(input.images));
        return "accepted";
      },
      async fork(forkParams: ModelSessionForkParams): Promise<ModelSessionFork> {
        if (closed) throw new Error("Cannot fork a closed ModelSession");
        if (running) throw new Error("Cannot fork while source session is running");
        const forkEntries = forkEntriesForCheckpoint(
          piSessionManager.getEntries(),
          forkParams.sourceCheckpoint,
        );
        const mode: ModelSessionForkMode = forkParams.mode ?? "ephemeral";
        let opened = false;
        return {
          providerId: "pi",
          sessionId: forkParams.sessionId,
          sourceSessionId: params.sessionId,
          sourceProviderThreadId: params.sessionId,
          mode,
          providerThreadId: forkParams.sessionId,
          open: async (openParams: ModelSessionForkOpenParams) => {
            if (opened) throw new Error("ModelSession fork already opened");
            opened = true;
            return await provider.openSessionWithEntries(
              {
                ...openParams,
                sessionId: forkParams.sessionId,
                isNewSession: false,
                providerThreadId: forkParams.sessionId,
              },
              forkEntries,
              // Ephemeral forks are throwaway previews; never persist them.
              mode !== "ephemeral",
            );
          },
        };
      },
      async interrupt() {
        await session.abort();
      },
      async close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (session.isStreaming) await session.abort().catch(() => undefined);
        session.dispose();
        sink.end();
      },
    };

    return modelSession;
  }
}

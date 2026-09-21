import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentAccounting, AgentMessage } from "../../types.js";

const QUALIFIED_MODEL_SEPARATOR = "/";

export interface PiModelDescriptor {
  /** Reversible value Rome can persist in its existing model-id field. */
  qualifiedModelId: string;
  upstreamProvider: string;
  modelId: string;
  name: string;
  api: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
}

export interface PiModelDiscovery {
  models: PiModelDescriptor[];
  /** Provider ids only: SDK error strings may include credential-backed config values. */
  refreshFailedProviders: string[];
  refreshAborted: boolean;
  configurationValid: boolean;
  eligibilityCaveat: string;
}

export interface PiRuntimePaths {
  agentDir?: string;
  allowModelNetwork?: boolean;
  refreshOnCreate?: boolean;
}

/**
 * Encode both halves because custom Pi provider names and model ids are not
 * guaranteed to exclude `/`. The pair remains readable for ordinary ids while
 * round-tripping collisions and custom names exactly.
 */
export function qualifyPiModelId(upstreamProvider: string, modelId: string): string {
  if (!upstreamProvider || !modelId) {
    throw new Error("Pi model provider and id must both be non-empty");
  }
  return `${encodeURIComponent(upstreamProvider)}${QUALIFIED_MODEL_SEPARATOR}${encodeURIComponent(modelId)}`;
}

export function parseQualifiedPiModelId(qualifiedModelId: string): {
  upstreamProvider: string;
  modelId: string;
} {
  const separator = qualifiedModelId.indexOf(QUALIFIED_MODEL_SEPARATOR);
  if (separator <= 0 || separator === qualifiedModelId.length - 1) {
    throw new Error(`Invalid qualified Pi model id: ${qualifiedModelId}`);
  }

  let upstreamProvider: string;
  let modelId: string;
  try {
    upstreamProvider = decodeURIComponent(qualifiedModelId.slice(0, separator));
    modelId = decodeURIComponent(qualifiedModelId.slice(separator + 1));
  } catch {
    throw new Error(`Invalid qualified Pi model id: ${qualifiedModelId}`);
  }
  if (
    !upstreamProvider ||
    !modelId ||
    qualifyPiModelId(upstreamProvider, modelId) !== qualifiedModelId
  ) {
    throw new Error(`Invalid qualified Pi model id: ${qualifiedModelId}`);
  }
  return { upstreamProvider, modelId };
}

export async function createPiModelRuntime(paths: PiRuntimePaths = {}): Promise<ModelRuntime> {
  const agentDir = paths.agentDir ?? getAgentDir();
  return await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: paths.allowModelNetwork ?? false,
    refreshOnCreate: paths.refreshOnCreate ?? true,
  });
}

export async function discoverPiModels(
  runtime: ModelRuntime,
  options: { refreshNetwork?: boolean; refreshTimeoutMs?: number } = {},
): Promise<PiModelDiscovery> {
  let refreshAborted = false;
  let refreshFailedProviders: string[] = [];
  if (options.refreshNetwork) {
    const refresh = await runtime.refresh({
      allowNetwork: true,
      force: true,
      signal: AbortSignal.timeout(options.refreshTimeoutMs ?? 15_000),
    });
    refreshAborted = refresh.aborted;
    refreshFailedProviders = [...refresh.errors.keys()].sort();
  }

  const available = await runtime.getAvailable();
  const models = available
    .map((model) => ({
      qualifiedModelId: qualifyPiModelId(model.provider, model.id),
      upstreamProvider: model.provider,
      modelId: model.id,
      name: model.name,
      api: model.api,
      input: [...model.input],
      reasoning: model.reasoning,
    }))
    .sort((left, right) => left.qualifiedModelId.localeCompare(right.qualifiedModelId));

  return {
    models,
    refreshFailedProviders,
    refreshAborted,
    configurationValid: runtime.getError() === undefined,
    eligibilityCaveat:
      "Pi reports authenticated models, but its SDK model metadata has no general tool-capability flag.",
  };
}

function textFromAssistant(
  message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
): string | undefined {
  if (message.role !== "assistant") return undefined;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function accountingFromAssistant(
  message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
  qualifiedModelId: string,
): AgentAccounting | undefined {
  if (message.role !== "assistant") return undefined;
  return {
    provider: "pi",
    model: qualifiedModelId,
    usage: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
    },
    costUsd: message.usage.cost.total,
    stopReason: message.stopReason,
  };
}

/**
 * Minimal event seam between the Pi SDK and Rome's provider-neutral stream.
 * It intentionally does not implement turn bracketing or persistence; those
 * belong to Rome's AgentSession when this becomes a production provider.
 */
export class PiEventBridge {
  private finalResponse?: { content: string; accounting: AgentAccounting };

  constructor(private readonly qualifiedModelId: string) {}

  accept(event: AgentSessionEvent): AgentMessage[] {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        return [{ type: "text_delta", content: event.assistantMessageEvent.delta }];
      }
      if (event.assistantMessageEvent.type === "thinking_end") {
        return [{ type: "thinking", content: event.assistantMessageEvent.content }];
      }
      return [];
    }

    if (event.type === "tool_execution_start") {
      return [
        {
          type: "tool_use",
          id: event.toolCallId,
          tool: event.toolName,
          input: event.args,
        },
      ];
    }
    if (event.type === "tool_execution_end") {
      return [
        {
          type: "tool_result",
          toolUseId: event.toolCallId,
          tool: event.toolName,
          output: event.result,
        },
      ];
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const content = textFromAssistant(event.message) ?? "";
      const accounting = accountingFromAssistant(event.message, this.qualifiedModelId);
      if (!accounting) return [];
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        return [
          {
            type: "error",
            error: event.message.errorMessage ?? `Pi turn ${event.message.stopReason}`,
            accounting,
          },
        ];
      }
      if (event.message.stopReason === "toolUse") {
        return content ? [{ type: "text", content, turnPhase: "commentary" }] : [];
      }
      this.finalResponse = { content, accounting };
      return content ? [{ type: "text", content, turnPhase: "final" }] : [];
    }

    if (event.type === "agent_end" && this.finalResponse) {
      const finalResponse = this.finalResponse;
      this.finalResponse = undefined;
      return [{ type: "result", ...finalResponse }];
    }
    return [];
  }
}

const RomeProbeParameters = Type.Object(
  { value: Type.String({ description: "Value Rome should echo back" }) },
  { additionalProperties: false },
);

export interface RunPiPrototypeTurnOptions {
  runtime: ModelRuntime;
  qualifiedModelId: string;
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  emit: (message: AgentMessage) => void;
}

async function requireAvailableModel(runtime: ModelRuntime, qualifiedModelId: string) {
  const { upstreamProvider, modelId } = parseQualifiedPiModelId(qualifiedModelId);
  const model = runtime.getModel(upstreamProvider, modelId);
  if (!model) throw new Error(`Pi model is not in the current catalog: ${qualifiedModelId}`);
  const available = await runtime.getAvailable(upstreamProvider);
  if (!available.some((candidate) => candidate.id === modelId)) {
    throw new Error(`Pi model is not currently authenticated: ${qualifiedModelId}`);
  }
  return model;
}

async function createIsolatedPiSession(options: {
  runtime: ModelRuntime;
  qualifiedModelId: string;
  cwd?: string;
  systemPrompt?: string;
}) {
  const model = await requireAvailableModel(options.runtime, options.qualifiedModelId);
  const cwd = options.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      options.systemPrompt ??
      "You are running inside Rome. Use only the tools Rome supplies and answer concisely.",
  });
  await resourceLoader.reload();

  const romeProbe = defineTool({
    name: "rome_probe",
    label: "Rome probe",
    description: "Echo a value through a Rome-owned tool callback.",
    parameters: RomeProbeParameters,
    async execute(toolCallId, params) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: "rome", toolCallId, value: params.value }),
          },
        ],
        details: { source: "rome" },
      };
    },
  });

  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime: options.runtime,
    tools: [romeProbe.name],
    customTools: [romeProbe],
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const activeTools = session.getActiveToolNames();
  if (activeTools.length !== 1 || activeTools[0] !== romeProbe.name) {
    session.dispose();
    throw new Error(`Unsafe Pi prototype tool loadout: ${activeTools.join(", ")}`);
  }
  return session;
}

export interface PiSessionIsolationInspection {
  activeTools: string[];
  sessionFile: string | null;
  systemPrompt: string;
}

/** Build and immediately dispose the session used by `run`, without a model request. */
export async function inspectPiSessionIsolation(options: {
  runtime: ModelRuntime;
  qualifiedModelId: string;
  cwd?: string;
}): Promise<PiSessionIsolationInspection> {
  const session = await createIsolatedPiSession(options);
  try {
    return {
      activeTools: session.getActiveToolNames(),
      sessionFile: session.sessionFile ?? null,
      systemPrompt: session.systemPrompt,
    };
  } finally {
    session.dispose();
  }
}

/**
 * Execute one in-memory Pi turn with a single harmless Rome-owned custom tool.
 * No Pi CLI, built-in shell/file tool, extension, skill, prompt template,
 * context file, Pi session file, or Pi UI is loaded.
 */
export async function runPiPrototypeTurn(options: RunPiPrototypeTurnOptions): Promise<void> {
  const session = await createIsolatedPiSession(options);

  const bridge = new PiEventBridge(options.qualifiedModelId);
  const unsubscribe = session.subscribe((event) => {
    for (const message of bridge.accept(event)) options.emit(message);
  });
  const abort = () => void session.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw options.signal.reason;
    await session.prompt(options.prompt, { expandPromptTemplates: false, source: "rpc" });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

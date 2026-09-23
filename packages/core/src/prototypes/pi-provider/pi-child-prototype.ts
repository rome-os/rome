import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { AgentMessage } from "../../types.js";
import type {
  ModelProvider,
  ModelSession,
  ModelSessionFork,
  ModelSessionParams,
  ModelUserInput,
  ProviderId,
} from "../../core/agent-runner.js";
import type { SettingsRepository } from "../../db/repositories/settings.js";
import {
  decodePiModelId,
  encodePiModelId,
  isReviewedPiProviderId,
  type PiReviewedProviderId,
} from "../../core/pi-provider-boundary.js";

export const PI_PROTOTYPE_CREDENTIAL_KEY_PREFIX = "prototype.piCredential.";
const PROVIDER_ENV: Partial<Record<PiReviewedProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
};
const childPath = join(dirname(fileURLToPath(import.meta.url)), "pi-child.mjs");

type SettingsStore = Pick<SettingsRepository, "get" | "set" | "delete">;

interface StoredCredential {
  provider: PiReviewedProviderId;
  token: string;
  updatedAt: string;
}

export interface PiCredentialStatus {
  provider: PiReviewedProviderId;
  configured: boolean;
  updatedAt?: string;
}

export function redactPiPrototypeCredentialSetting(value: unknown): PiCredentialStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Partial<StoredCredential>;
  if (
    typeof stored.provider !== "string" ||
    !isReviewedPiProviderId(stored.provider) ||
    typeof stored.token !== "string" ||
    typeof stored.updatedAt !== "string"
  ) {
    return null;
  }
  return { provider: stored.provider, configured: true, updatedAt: stored.updatedAt };
}

export class PiPrototypeCredentialStore {
  constructor(private readonly settings: SettingsStore) {}

  async save(provider: PiReviewedProviderId, submittedToken: string): Promise<PiCredentialStatus> {
    const token = submittedToken.trim();
    if (!token || token.length > 8192 || /[\p{Cc}\p{Cs}]/u.test(token)) {
      throw new Error("Enter one API token without line breaks or control characters.");
    }
    const value: StoredCredential = { provider, token, updatedAt: new Date().toISOString() };
    await this.settings.set(`${PI_PROTOTYPE_CREDENTIAL_KEY_PREFIX}${provider}`, value);
    return { provider, configured: true, updatedAt: value.updatedAt };
  }

  async status(provider: PiReviewedProviderId): Promise<PiCredentialStatus> {
    const stored = await this.read(provider);
    return { provider, configured: stored !== null, updatedAt: stored?.updatedAt };
  }

  async remove(provider: PiReviewedProviderId): Promise<PiCredentialStatus> {
    await this.settings.delete(`${PI_PROTOTYPE_CREDENTIAL_KEY_PREFIX}${provider}`);
    return { provider, configured: false };
  }

  async loadForOperation(provider: PiReviewedProviderId): Promise<string> {
    const stored = await this.read(provider);
    if (!stored) throw new Error("Configure this Pi provider before using it.");
    return stored.token;
  }

  private async read(provider: PiReviewedProviderId): Promise<StoredCredential | null> {
    const value = await this.settings.get<StoredCredential>(
      `${PI_PROTOTYPE_CREDENTIAL_KEY_PREFIX}${provider}`,
    );
    return value?.provider === provider && typeof value.token === "string" ? value : null;
  }
}

interface ChildIsolationEvent {
  type: "isolation";
  environmentNames: string[];
  selectedCredentialPresent: boolean;
}

interface ChildModelsEvent {
  type: "models";
  models: Array<{ provider: string; id: string; name: string }>;
}

interface ChildTextEvent {
  type: "text_delta";
  content: string;
}

interface ChildDoneEvent {
  type: "done";
  content: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  stopReason: string;
}

interface ChildErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export type PiChildEvent =
  | ChildIsolationEvent
  | ChildModelsEvent
  | ChildTextEvent
  | ChildDoneEvent
  | ChildErrorEvent;

interface ChildRequest {
  operation: "discover" | "run" | "probe";
  model?: string;
  systemPrompt?: string;
  prompt?: string;
  timeoutMs?: number;
  fixture?: { response: string; waitForCancellation?: boolean };
}

export interface PiChildOperation {
  provider: PiReviewedProviderId;
  credential?: string;
  request: ChildRequest;
  signal?: AbortSignal;
}

async function makeIsolationDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rome-pi-child-"));
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "auth.json"), "{}", { mode: 0o600 }),
    writeFile(join(directory, "models.json"), '{"providers":{}}', { mode: 0o600 }),
    writeFile(join(directory, "models-store.json"), "{}", { mode: 0o600 }),
  ]);
  return directory;
}

/** A fresh child receives an explicit, minimal environment; daemon process.env is never changed. */
export async function* runIsolatedPiChild(options: PiChildOperation): AsyncIterable<PiChildEvent> {
  const credentialEnv = PROVIDER_ENV[options.provider];
  if (options.credential && !credentialEnv)
    throw new Error("This prototype supports Anthropic only.");
  const directory = await makeIsolationDirectory();
  const env: NodeJS.ProcessEnv = {
    PI_OFFLINE: "1",
    ROME_PI_SELECTED_PROVIDER: options.provider,
  };
  if (credentialEnv && options.credential) env[credentialEnv] = options.credential;

  const child = spawn(process.execPath, [childPath, directory], {
    cwd: directory,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let exited = false;
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    lines.push(line);
    wake?.();
    wake = undefined;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      wake?.();
      resolve(code);
    });
  });
  const cancel = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", cancel, { once: true });
  child.stdin.end(JSON.stringify(options.request));

  try {
    while (!exited || lines.length > 0) {
      if (lines.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const value = JSON.parse(lines.shift() ?? "null") as PiChildEvent;
      yield value;
    }
    const code = await exit;
    if (options.signal?.aborted) throw new Error("The isolated Pi operation was cancelled.");
    if (code !== 0) throw new Error("The isolated Pi operation failed.");
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    if (!exited) child.kill("SIGTERM");
    reader.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function discoverPiModels(
  credentials: PiPrototypeCredentialStore,
  provider: PiReviewedProviderId,
): Promise<Array<{ id: string; name: string }>> {
  const credential = await credentials.loadForOperation(provider);
  for await (const event of runIsolatedPiChild({
    provider,
    credential,
    request: { operation: "discover" },
  })) {
    if (event.type === "models") {
      return event.models
        .filter((model) => model.provider === provider)
        .map((model) => ({
          id: encodePiModelId({ upstreamProvider: model.provider, upstreamModel: model.id }),
          name: `${model.provider} / ${model.name}`,
        }));
    }
  }
  return [];
}

class MessageQueue implements AsyncIterable<AgentMessage> {
  private values: AgentMessage[] = [];
  private waits: Array<(value: IteratorResult<AgentMessage>) => void> = [];
  private ended = false;

  emit(value: AgentMessage): void {
    const wait = this.waits.shift();
    if (wait) wait({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    for (const wait of this.waits.splice(0)) wait({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentMessage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<AgentMessage>>((resolve) =>
          this.waits.push(resolve),
        );
      },
    };
  }
}

export class PiChildPrototypeProvider implements ModelProvider {
  readonly id = "pi" as ProviderId;
  readonly displayName = "Pi Coding Agent (isolated-child prototype)";
  readonly builtinTools = new Set<string>();

  constructor(
    private readonly credentials: PiPrototypeCredentialStore,
    private readonly fixture?: { response: string; waitForCancellation?: boolean },
  ) {}

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    const selected = decodePiModelId(params.model);
    if (!isReviewedPiProviderId(selected.upstreamProvider)) {
      throw new Error("Choose a reviewed Pi provider.");
    }
    const provider = selected.upstreamProvider;
    const queue = new MessageQueue();
    const credentialStore = this.credentials;
    const fixture = this.fixture;
    let controller: AbortController | undefined;
    let closed = false;

    return {
      providerId: this.id,
      model: params.model,
      events: queue,
      async sendUserInput(input: ModelUserInput): Promise<void> {
        if (closed || controller) throw new Error("The Pi prototype session is not ready.");
        controller = new AbortController();
        const current = controller;
        void (async () => {
          try {
            const credential = await credentialStore.loadForOperation(provider);
            for await (const event of runIsolatedPiChild({
              provider,
              credential,
              signal: current.signal,
              request: {
                operation: "run",
                model: selected.upstreamModel,
                systemPrompt: params.systemPrompt,
                prompt: input.text,
                fixture,
              },
            })) {
              if (event.type === "text_delta") {
                queue.emit({ type: "text_delta", content: event.content });
              }
              if (event.type === "done") {
                const accounting = {
                  provider: "pi",
                  model: params.model,
                  usage: {
                    inputTokens: event.usage.input,
                    outputTokens: event.usage.output,
                    cacheReadTokens: event.usage.cacheRead,
                    cacheWriteTokens: event.usage.cacheWrite,
                  },
                  costUsd: event.usage.cost,
                  stopReason: event.stopReason,
                };
                queue.emit({ type: "text", content: event.content, turnPhase: "final" });
                queue.emit({ type: "result", content: event.content, accounting });
              }
              if (event.type === "error") throw new Error(event.message);
            }
          } catch {
            if (!current.signal.aborted) {
              queue.emit({ type: "error", error: "The isolated Pi operation failed." });
            }
          } finally {
            if (controller === current) controller = undefined;
          }
        })();
      },
      async fork(): Promise<ModelSessionFork> {
        throw new Error("The Pi prototype does not support session forks.");
      },
      async interrupt(): Promise<void> {
        controller?.abort();
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        controller?.abort();
        queue.close();
      },
    };
  }
}

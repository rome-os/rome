import { randomUUID } from "node:crypto";
import type {
  AgentRunnerInterface,
  ImageGenerationContext,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageProviderAvailability,
  ImageProviderGenerateResult,
} from "@rome-os/app-runtime";
import { createLogger } from "../../logger.js";

const log = createLogger("codex-image-provider");

/** Agent (system app, agents/image-gen.yaml) pinned to the Codex model provider. */
const IMAGE_GEN_AGENT = "image_gen";

/** Tool name the Codex model provider assigns to embedded image-generation trace events. */
const IMAGE_GENERATION_TOOL = "ImageGeneration";

const CONNECT_REMEDY = "Connect Codex under AI tools, then retry.";

interface ImageGenerationPayload {
  status?: string;
  error?: string;
  data?: string;
  mimeType?: string;
  savedPath?: string;
  revisedPrompt?: string;
  /**
   * "codex_generated_images" marks a filesystem-backstop result: inferred from
   * a file appearing under ~/.codex/generated_images rather than correlated to
   * an image-generation call in this stream. See core/codex/image-trace.ts.
   */
  source?: string;
}

const BACKSTOP_SOURCE = "codex_generated_images";

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the `{ type: "image", ... }` payload the Codex provider puts on ImageGeneration tool results. */
export function parseImageGenerationOutput(output: unknown): ImageGenerationPayload | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  if (record.type !== "image") return null;
  return {
    status: readStringField(record, "status"),
    error: readStringField(record, "error"),
    data: readStringField(record, "data"),
    mimeType: readStringField(record, "mimeType"),
    savedPath: readStringField(record, "saved_path") ?? readStringField(record, "savedPath"),
    revisedPrompt: readStringField(record, "revised_prompt"),
    source: readStringField(record, "source"),
  };
}

function isUsable(payload: ImageGenerationPayload): boolean {
  if (payload.error || payload.status === "failed") return false;
  return Boolean(payload.data || payload.savedPath);
}

// The image_gen agent is pinned to the Codex provider, so when Codex is not
// connected (or out of quota) the run fails with a ModelResolutionError
// instead of silently falling back to a provider that cannot generate images.
// That failure reaches us either as a stream `error` message carrying a
// machine-readable code, or as a thrown error where only the message text
// survives worker IPC — recognize both.
const PROVIDER_UNAVAILABLE_CODES = new Set([
  "model_provider_unavailable",
  "no_model_provider_available",
  "auth_revoked",
  "usage_limit",
  "credits_used_up",
]);

function isProviderUnavailableFailure(message: string, code?: string): boolean {
  return (
    (code !== undefined && PROVIDER_UNAVAILABLE_CODES.has(code)) ||
    /model provider is unavailable|no model provider is available/i.test(message)
  );
}

function runFailureResult(message: string, code?: string): ImageProviderGenerateResult {
  if (isProviderUnavailableFailure(message, code)) {
    return { status: "unavailable", reason: message, remedy: CONNECT_REMEDY };
  }
  return { status: "failed", message };
}

export interface CodexImageProviderDeps {
  agentRunner: AgentRunnerInterface;
  /**
   * Snapshot of the Codex account state (`AiToolState.get().codex`) — the same
   * source of truth the model resolver gates on, so availability never needs a
   * separate probe. Optional: action workers have no AiToolState, so their
   * provider reports available and relies on `generate` failing closed via the
   * pinned agent's model resolution, whose error streams back over RPC with a
   * machine-readable code.
   */
  getCodexState?: () => { loggedIn?: boolean; quotaExhausted: boolean };
}

/**
 * Image generation backed by the connected Codex (ChatGPT) account: forwards
 * the prompt to the Codex-pinned `image_gen` agent and harvests the
 * ImageGeneration tool result its embedded image tool produces.
 */
export function createCodexImageGenerationProvider(
  deps: CodexImageProviderDeps,
): ImageGenerationProvider {
  return {
    id: "codex",
    displayName: "Codex (ChatGPT)",

    async availability(): Promise<ImageProviderAvailability> {
      const state = deps.getCodexState?.();
      if (!state) return { available: true };
      // Reads the ChatGPT login, not the resolver's Rome credits view: the
      // credits gateway rejects hosted image generation. An undefined
      // loggedIn means "not probed yet" and is treated optimistically.
      if (state.loggedIn === false) {
        return {
          available: false,
          reason: "the Codex (ChatGPT) account is not connected",
          remedy: CONNECT_REMEDY,
        };
      }
      if (state.quotaExhausted) {
        return {
          available: false,
          reason: "the Codex (ChatGPT) account has hit its usage limit",
          remedy: "Wait for the Codex usage limit to reset, then retry.",
        };
      }
      return { available: true };
    },

    async generate(
      request: ImageGenerationRequest,
      ctx?: ImageGenerationContext,
    ): Promise<ImageProviderGenerateResult> {
      // A run's stream can carry two kinds of usable results: ones correlated
      // to this turn's actual image-generation call, and filesystem-backstop
      // results (marked with `source`) inferred from files appearing under the
      // generated-images tree. The backstop scan is thread-scoped in the model
      // provider, but a directly-correlated result must still always beat an
      // inferred one — a backstop entry must never override the image this
      // turn's call actually produced.
      let direct: ImageGenerationPayload | undefined;
      let backstop: ImageGenerationPayload | undefined;
      let failed: ImageGenerationPayload | undefined;
      let finalText = "";
      let streamError = "";
      let streamErrorCode: string | undefined;

      const inputImages = request.inputImagePaths ?? [];
      const instruction =
        inputImages.length > 0
          ? `Generate an image with your built-in image generation tool. The ${inputImages.length} attached image(s) are the inputs the prompt refers to — edit or combine them as it describes.`
          : "Generate an image with your built-in image generation tool.";

      try {
        for await (const msg of deps.agentRunner.run({
          agentName: IMAGE_GEN_AGENT,
          // A fresh session per call. Concurrent calls (generate_image batches)
          // rely on it: the generated-images backstop is scoped to the Codex
          // thread, so a shared thread could hand one call another's image.
          channelThreadKey: `${IMAGE_GEN_AGENT}:${randomUUID()}`,
          prompt: `${instruction} Use this prompt verbatim:\n\n${request.prompt}`,
          ...(inputImages.length > 0 ? { images: inputImages } : {}),
          sharedContext: ctx?.sharedContext,
        })) {
          if (msg.type === "tool_result" && msg.tool === IMAGE_GENERATION_TOOL) {
            const parsed = parseImageGenerationOutput(msg.output);
            if (!parsed) continue;
            if (!isUsable(parsed)) failed = parsed;
            else if (parsed.source === BACKSTOP_SOURCE) backstop = parsed;
            else direct = parsed;
          } else if (msg.type === "result") {
            finalText = msg.content;
          } else if (msg.type === "error") {
            streamError = msg.error;
            streamErrorCode = msg.code;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("image generation run failed", { error: message });
        return runFailureResult(message);
      }

      const payload = direct ?? backstop;
      if (streamError && !payload) {
        return runFailureResult(streamError, streamErrorCode);
      }
      if (!payload) {
        const detail = failed?.error ?? finalText;
        return {
          status: "failed",
          message: `The model did not produce an image.${detail ? ` ${detail}` : ""}`,
        };
      }

      return {
        status: "ok",
        image: {
          ...(payload.data ? { data: payload.data } : {}),
          ...(payload.savedPath ? { sourcePath: payload.savedPath } : {}),
          ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
          ...(payload.revisedPrompt ? { revisedPrompt: payload.revisedPrompt } : {}),
        },
      };
    },
  };
}

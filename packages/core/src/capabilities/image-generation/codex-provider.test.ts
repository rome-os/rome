import { describe, expect, it, rs } from "@rstest/core";
import type { AgentMessage, AgentRunnerInterface } from "@rome-os/app-runtime";
import {
  createCodexImageGenerationProvider,
  parseImageGenerationOutput,
} from "./codex-provider.js";

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeRunner(
  messages: AgentMessage[],
): AgentRunnerInterface & { run: ReturnType<typeof rs.fn> } {
  const run = rs.fn(async function* () {
    for (const message of messages) yield message;
  });
  return { run } as unknown as AgentRunnerInterface & { run: ReturnType<typeof rs.fn> };
}

function imageResult(output: unknown): AgentMessage {
  return { type: "tool_result", toolUseId: "tu-1", tool: "ImageGeneration", output };
}

describe("createCodexImageGenerationProvider", () => {
  describe("generate", () => {
    it("forwards the prompt to the image_gen agent and returns the inline image", async () => {
      const runner = makeRunner([
        imageResult({
          type: "image",
          status: "completed",
          revised_prompt: "a refined red fox",
          data: PNG_BASE64,
          mimeType: "image/png",
        }),
        { type: "result", content: "Image generated." },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const sharedContext = { sessionId: "s-1" };
      const result = await provider.generate(
        { prompt: "a red fox in the snow" },
        { sharedContext },
      );

      expect(runner.run).toHaveBeenCalledTimes(1);
      const params = runner.run.mock.calls[0][0];
      expect(params.agentName).toBe("image_gen");
      expect(params.prompt).toContain("a red fox in the snow");
      expect(params.sharedContext).toBe(sharedContext);

      expect(result).toEqual({
        status: "ok",
        image: { data: PNG_BASE64, mimeType: "image/png", revisedPrompt: "a refined red fox" },
      });
    });

    it("returns the provider-saved path when no inline data is present", async () => {
      const runner = makeRunner([
        imageResult({ type: "image", status: "completed", saved_path: "/tmp/codex-original.webp" }),
        { type: "result", content: "Done." },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result).toEqual({
        status: "ok",
        image: { sourcePath: "/tmp/codex-original.webp" },
      });
    });

    it("attaches input images to the forwarder run and tells the agent to use them", async () => {
      const runner = makeRunner([
        imageResult({
          type: "image",
          status: "completed",
          data: PNG_BASE64,
          mimeType: "image/png",
        }),
        { type: "result", content: "Done." },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({
        prompt: "combine these into one scene",
        inputImagePaths: ["/tmp/a.png", "/tmp/b.png"],
      });

      expect(result.status).toBe("ok");
      const params = runner.run.mock.calls[0][0];
      expect(params.images).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(params.prompt).toContain("2 attached image(s)");
      expect(params.prompt).toContain("combine these into one scene");
    });

    it("never lets a filesystem-backstop result override this turn's own image", async () => {
      // Concurrent-generation regression: the shared generated-images backstop
      // can surface another in-flight request's file. Even when that foreign
      // backstop result arrives AFTER this turn's directly-correlated result,
      // the correlated one must win.
      const runner = makeRunner([
        imageResult({
          type: "image",
          status: "completed",
          data: PNG_BASE64,
          mimeType: "image/png",
        }),
        imageResult({
          type: "image",
          status: "completed",
          saved_path: "/tmp/other-requests-image.png",
          source: "codex_generated_images",
        }),
        { type: "result", content: "Done." },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result).toEqual({
        status: "ok",
        image: { data: PNG_BASE64, mimeType: "image/png" },
      });
    });

    it("still uses a backstop result when no correlated result arrives", async () => {
      // The backstop exists because Codex sometimes writes the file without an
      // SDK stream event — with no direct result, the (thread-scoped) backstop
      // result is the image.
      const runner = makeRunner([
        imageResult({
          type: "image",
          status: "completed",
          saved_path: "/tmp/backstop-only.png",
          source: "codex_generated_images",
        }),
        { type: "result", content: "Done." },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result).toEqual({
        status: "ok",
        image: { sourcePath: "/tmp/backstop-only.png" },
      });
    });

    it("keeps the last usable image when several results arrive", async () => {
      const runner = makeRunner([
        imageResult({ type: "image", status: "failed", error: "safety rejection" }),
        imageResult({
          type: "image",
          status: "completed",
          data: PNG_BASE64,
          mimeType: "image/png",
        }),
        { type: "result", content: "Done." },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result.status).toBe("ok");
    });

    it("fails when the model never produces an image", async () => {
      const runner = makeRunner([{ type: "result", content: "I cannot generate images." }]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result).toEqual({
        status: "failed",
        message: "The model did not produce an image. I cannot generate images.",
      });
    });

    it("surfaces the tool's own failure detail when generation failed", async () => {
      const runner = makeRunner([
        imageResult({ type: "image", status: "failed", error: "content policy" }),
        { type: "result", content: "" },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result.status).toBe("failed");
      expect((result as { message: string }).message).toContain("content policy");
    });

    it("maps a provider-unavailable stream error to an unavailable result", async () => {
      const runner = makeRunner([
        {
          type: "error",
          error: "Selected model provider is unavailable: Codex (ChatGPT)",
          code: "model_provider_unavailable",
          provider: "openai",
          reason: "not_logged_in",
        },
      ]);
      const provider = createCodexImageGenerationProvider({ agentRunner: runner });

      const result = await provider.generate({ prompt: "anything" });

      expect(result).toEqual({
        status: "unavailable",
        reason: "Selected model provider is unavailable: Codex (ChatGPT)",
        remedy: "Connect Codex under AI tools, then retry.",
      });
    });

    it("maps a thrown resolution failure to an unavailable result", async () => {
      const run = rs.fn(async function* (): AsyncGenerator<AgentMessage> {
        throw new Error("Selected model provider is unavailable: Codex (ChatGPT)");
      });
      const provider = createCodexImageGenerationProvider({
        agentRunner: { run } as unknown as AgentRunnerInterface,
      });

      const result = await provider.generate({ prompt: "anything" });

      expect(result.status).toBe("unavailable");
      expect((result as { remedy: string }).remedy).toContain("Connect Codex");
    });

    it("maps an unrelated thrown error to a failed result", async () => {
      const run = rs.fn(async function* (): AsyncGenerator<AgentMessage> {
        throw new Error("worker crashed");
      });
      const provider = createCodexImageGenerationProvider({
        agentRunner: { run } as unknown as AgentRunnerInterface,
      });

      const result = await provider.generate({ prompt: "anything" });

      expect(result).toEqual({ status: "failed", message: "worker crashed" });
    });
  });

  describe("availability", () => {
    const runner = makeRunner([]);

    it("is optimistic without a state source (workers) and when not probed yet", async () => {
      const noSource = createCodexImageGenerationProvider({ agentRunner: runner });
      await expect(noSource.availability()).resolves.toEqual({ available: true });

      const unprobed = createCodexImageGenerationProvider({
        agentRunner: runner,
        getCodexState: () => ({ quotaExhausted: false }),
      });
      await expect(unprobed.availability()).resolves.toEqual({ available: true });
    });

    it("reports not-connected with a connect remedy when logged out", async () => {
      const provider = createCodexImageGenerationProvider({
        agentRunner: runner,
        getCodexState: () => ({ loggedIn: false, quotaExhausted: false }),
      });

      const availability = await provider.availability();

      expect(availability.available).toBe(false);
      if (!availability.available) {
        expect(availability.reason).toContain("not connected");
        expect(availability.remedy).toContain("Connect Codex");
      }
    });

    it("reports unavailable when the quota is exhausted", async () => {
      const provider = createCodexImageGenerationProvider({
        agentRunner: runner,
        getCodexState: () => ({ loggedIn: true, quotaExhausted: true }),
      });

      const availability = await provider.availability();

      expect(availability.available).toBe(false);
      if (!availability.available) {
        expect(availability.reason).toContain("usage limit");
      }
    });
  });
});

describe("parseImageGenerationOutput", () => {
  it("parses the image payload fields, including snake_case aliases", () => {
    expect(
      parseImageGenerationOutput({
        type: "image",
        status: "completed",
        data: PNG_BASE64,
        mimeType: "image/png",
        saved_path: "/tmp/a.png",
        revised_prompt: "refined",
      }),
    ).toEqual({
      status: "completed",
      error: undefined,
      data: PNG_BASE64,
      mimeType: "image/png",
      savedPath: "/tmp/a.png",
      revisedPrompt: "refined",
    });
  });

  it("rejects non-image payloads", () => {
    expect(parseImageGenerationOutput(null)).toBeNull();
    expect(parseImageGenerationOutput("image")).toBeNull();
    expect(parseImageGenerationOutput({ type: "text" })).toBeNull();
    expect(parseImageGenerationOutput([{ type: "image" }])).toBeNull();
  });
});

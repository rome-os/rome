import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { dirname } from "node:path";
import { setCurrentActionContextResolver } from "@rome-os/app-runtime";
import * as browserRuntimeModule from "@rome-os/app-runtime/browser" with {
  rstest: "importActual",
};

const { buildBrowserScriptExpressionMock, loadCachedScriptSourceMock } = rs.hoisted(() => ({
  buildBrowserScriptExpressionMock: rs.fn(),
  loadCachedScriptSourceMock: rs.fn(),
}));

rs.mock("@rome-os/app-runtime/browser", () => ({
  ...browserRuntimeModule,
  buildBrowserScriptExpression: buildBrowserScriptExpressionMock,
  loadCachedScriptSource: loadCachedScriptSourceMock,
}));

import { createFakeOpencli } from "../../../test/fake-opencli.js";
import { createChatGPTImageAction, type ChatGPTImageBrowserResult } from "./index.js";

describe("chatgpt_image action", () => {
  beforeEach(() => {
    rs.clearAllMocks();
    setCurrentActionContextResolver(null);
  });

  it("requires a prompt", async () => {
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
      },
    );

    await expect(action.execute({ path: "/tmp/apple.png" })).resolves.toEqual({
      status: "error",
      error: "prompt is required",
    });
  });

  it("requires a relative_path", async () => {
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
      },
    );

    await expect(action.execute({ prompt: "apple" })).resolves.toEqual({
      status: "error",
      error: "relative_path is required",
    });
  });

  it("rejects the legacy path arg", async () => {
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
      },
    );

    await expect(action.execute({ prompt: "apple", path: "/tmp/apple.png" })).resolves.toEqual({
      status: "error",
      error: "path is no longer supported; use relative_path",
    });
  });

  it("writes the generated image bytes to the thread-relative path", async () => {
    const browserResult: ChatGPTImageBrowserResult = {
      prompt: "apple",
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
      mimeType: "image/png",
      imageDataBase64: Buffer.from("fake image bytes").toString("base64"),
      width: 1024,
      height: 1024,
    };
    const runImageGeneration = rs.fn().mockResolvedValue({
      browser: "cdp-local-chromium",
      result: browserResult,
    });
    const mkdirMock = rs.fn().mockResolvedValue(undefined);
    const writeFileMock = rs.fn().mockResolvedValue(undefined);
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
        runImageGeneration,
        mkdir: mkdirMock,
        writeFile: writeFileMock,
      },
    );

    setCurrentActionContextResolver(() => ({
      channelContext: {
        channel: "webchat",
        threadId: "thread-123",
        projectName: "sunrise",
      },
    }));

    const expectedPath = "/home/user/sunrise/.threads/thread-123/tmp/apple.png";
    const result = await action.execute({ prompt: "apple", relative_path: "tmp/apple.png" });

    expect(runImageGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: "apple",
        pageUrl: "https://chatgpt.com/",
        timeoutMs: 900000,
      }),
      expect.anything(),
    );
    expect(mkdirMock).toHaveBeenCalledWith(dirname(expectedPath), { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith(expectedPath, Buffer.from("fake image bytes"));
    expect(result).toEqual({
      status: "ok",
      data: {
        path: expectedPath,
        prompt: "apple",
        imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        browser: "cdp-local-chromium",
      },
    });
  });

  it("returns a clear error when relative_path is used outside a project thread", async () => {
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
        runImageGeneration: rs.fn().mockResolvedValue({
          browser: "cdp-local-chromium",
          result: {
            prompt: "apple",
            imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
            mimeType: "image/png",
            imageDataBase64: Buffer.from("fake image bytes").toString("base64"),
          },
        }),
      },
    );

    await expect(
      action.execute({
        prompt: "apple",
        relative_path: "sunshine.png",
      }),
    ).resolves.toEqual({
      status: "error",
      error: "projectName is required when using a relative output path",
    });
  });

  it("uses the runtime threadPath when provided", async () => {
    const browserResult: ChatGPTImageBrowserResult = {
      prompt: "apple",
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
      mimeType: "image/png",
      imageDataBase64: Buffer.from("fake image bytes").toString("base64"),
    };
    const mkdirMock = rs.fn().mockResolvedValue(undefined);
    const writeFileMock = rs.fn().mockResolvedValue(undefined);
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
        runImageGeneration: rs.fn().mockResolvedValue({
          browser: "cdp-local-chromium",
          result: browserResult,
        }),
        mkdir: mkdirMock,
        writeFile: writeFileMock,
      },
    );

    setCurrentActionContextResolver(() => ({
      channelContext: {
        channel: "webchat",
        threadId: "thread-456",
        threadPath: "/tmp/runtime-threads/thread-456",
      },
    }));

    await expect(
      action.execute({ prompt: "apple", relative_path: "images/apple.png" }),
    ).resolves.toEqual({
      status: "ok",
      data: {
        path: "/tmp/runtime-threads/thread-456/images/apple.png",
        prompt: "apple",
        imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
        mimeType: "image/png",
        width: undefined,
        height: undefined,
        browser: "cdp-local-chromium",
      },
    });

    expect(mkdirMock).toHaveBeenCalledWith("/tmp/runtime-threads/thread-456/images", {
      recursive: true,
    });
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/runtime-threads/thread-456/images/apple.png",
      Buffer.from("fake image bytes"),
    );
  });

  it("returns browser automation errors", async () => {
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: {} as never,
        runImageGeneration: rs
          .fn()
          .mockRejectedValue(new Error("ChatGPT Images send button is unavailable")),
      },
    );

    setCurrentActionContextResolver(() => ({
      channelContext: {
        channel: "webchat",
        threadId: "thread-789",
        projectName: "sunrise",
      },
    }));

    await expect(action.execute({ prompt: "apple", relative_path: "apple.png" })).resolves.toEqual({
      status: "error",
      error: "ChatGPT Images send button is unavailable",
    });
  });

  it("generates through OpenCLI's Browser Bridge when CDP discovery found no browser", async () => {
    // Discovery stays empty while ROME_ENABLE_CDP_AUTOMATION=false, the shipped default.
    const conversationUrl = "https://chatgpt.com/c/example-conversation";
    loadCachedScriptSourceMock.mockResolvedValue("// browser script");
    const fake = createFakeOpencli();
    // The page scripts read their inputs and results from the page's globals.
    fake.testGlobals.conversationUrl = conversationUrl;
    fake.testGlobals.download = {
      imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
      mimeType: "image/png",
      imageDataBase64: Buffer.from("fake image bytes").toString("base64"),
      width: 1024,
      height: 1024,
    };
    buildBrowserScriptExpressionMock.mockImplementation(
      ({ entrypointExpression }: { entrypointExpression: string }) =>
        entrypointExpression.includes("generateChatGPTImage")
          ? `(async () => {
            history.pushState(null, "", globalThis.__test.conversationUrl);
            return { prompt: "apple", conversationUrl: location.href };
          })()`
          : "(async () => globalThis.__test.download)()",
    );
    const writeFileMock = rs.fn().mockResolvedValue(undefined);
    const action = createChatGPTImageAction(
      {
        name: "chatgpt_image",
        type: "custom",
        description: "Generate image with ChatGPT",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
      },
      {
        capabilityDiscovery: { getBrowserEndpoints: () => [] },
        runOpencli: fake.run,
        mkdir: rs.fn().mockResolvedValue(undefined),
        writeFile: writeFileMock,
        getCurrentActionContext: () => ({
          channelContext: {
            channel: "webchat",
            threadId: "thread-321",
            threadPath: "/tmp/runtime-threads/thread-321",
          },
        }),
      },
    );

    rs.useFakeTimers();
    try {
      let settled = false;
      const pending = action
        .execute({ prompt: "apple", relative_path: "apple.png" })
        .finally(() => {
          settled = true;
        });
      while (!settled) {
        await rs.advanceTimersByTimeAsync(500);
      }

      await expect(pending).resolves.toEqual({
        status: "ok",
        data: {
          path: "/tmp/runtime-threads/thread-321/apple.png",
          prompt: "apple",
          imageUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_apple",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          browser: "opencli",
        },
      });
    } finally {
      rs.useRealTimers();
    }
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/runtime-threads/thread-321/apple.png",
      Buffer.from("fake image bytes"),
    );
    expect(fake.calls[0]).toEqual([
      "browser",
      "open",
      "https://chatgpt.com/",
      "--session",
      expect.stringMatching(/^rome-chatgpt-image-/),
    ]);
    expect(fake.subcommands().at(-1)).toBe("close");
  });
});

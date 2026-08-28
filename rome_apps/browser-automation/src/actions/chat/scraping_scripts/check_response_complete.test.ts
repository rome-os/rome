import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, rs } from "@rstest/core";

const scriptSource = readFileSync(new URL("./check_response_complete.js", import.meta.url), "utf8");

function loadScript(responseFactory: () => unknown[]) {
  const document = {
    querySelectorAll: rs.fn((selector: string) => {
      if (selector === "article") {
        return responseFactory();
      }

      if (selector === "h4") {
        return [];
      }

      return [];
    }),
  };
  const context = {
    console,
    document,
    window: {},
    Date,
    setTimeout,
    clearTimeout,
    MouseEvent: function MouseEvent(type: string, init: Record<string, unknown>) {
      return { type, ...init };
    },
    __ROME_CHATGPT_CHECK_RESPONSE_COMPLETE_AUTORUN__: false,
  } as Record<string, unknown>;
  context.globalThis = context;

  vm.runInNewContext(scriptSource, context);

  return { context, document };
}

describe("check_response_complete script", () => {
  it("returns complete once the latest response exposes its toolbar actions", async () => {
    const scrollIntoView = rs.fn();
    const dispatchEvent = rs.fn();
    const parentElement = {
      dispatchEvent,
      querySelector: rs.fn(() => null),
    };
    const copyButton = { id: "copy" };
    const response = {
      parentElement,
      scrollIntoView,
      querySelector: rs.fn((selector: string) => {
        if (selector === '[data-message-author-role="assistant"]') {
          return { id: "assistant" };
        }

        if (selector === 'button[aria-label="Copy response"]') {
          return copyButton;
        }

        return null;
      }),
    };
    const { context } = loadScript(() => [response]);

    const result = await (
      context.waitForLatestChatGPTResponseComplete as (options?: {
        timeout?: number;
      }) => Promise<{ complete: boolean }>
    )({ timeout: 5_000 });

    expect(result).toEqual({ complete: true });
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
    expect(dispatchEvent).toHaveBeenCalledTimes(3);
  });

  it("returns incomplete after the timeout window elapses", async () => {
    rs.useFakeTimers();
    try {
      const scrollIntoView = rs.fn();
      const dispatchEvent = rs.fn();
      const parentElement = {
        dispatchEvent,
        querySelector: rs.fn(() => null),
      };
      const response = {
        parentElement,
        scrollIntoView,
        querySelector: rs.fn((selector: string) => {
          if (selector === '[data-message-author-role="assistant"]') {
            return { id: "assistant" };
          }

          return null;
        }),
      };
      const { context } = loadScript(() => [response]);

      const resultPromise = (
        context.waitForLatestChatGPTResponseComplete as (options?: {
          timeout?: number;
        }) => Promise<{ complete: boolean }>
      )({ timeout: 400 });

      await rs.runAllTimersAsync();

      await expect(resultPromise).resolves.toEqual({ complete: false });
    } finally {
      rs.useRealTimers();
    }
  });
});

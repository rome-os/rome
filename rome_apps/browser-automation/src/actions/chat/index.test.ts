import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as browserRuntimeModule from "@rome-os/app-runtime/browser" with {
  rstest: "importActual",
};

const {
  buildBrowserScriptExpressionMock,
  loadCachedScriptSourceMock,
  openDiscoveredPageSessionMock,
  acquireChatGPTClipboardLockMock,
} = rs.hoisted(() => ({
  buildBrowserScriptExpressionMock: rs.fn(),
  loadCachedScriptSourceMock: rs.fn(),
  openDiscoveredPageSessionMock: rs.fn(),
  acquireChatGPTClipboardLockMock: rs.fn(),
}));

rs.mock("@rome-os/app-runtime/browser", () => ({
  ...browserRuntimeModule,
  buildBrowserScriptExpression: buildBrowserScriptExpressionMock,
  loadCachedScriptSource: loadCachedScriptSourceMock,
  openDiscoveredPageSession: openDiscoveredPageSessionMock,
}));

rs.mock("./clipboard_lock.js", () => ({
  acquireChatGPTClipboardLock: acquireChatGPTClipboardLockMock,
}));

import { createChatGPTChatAction, postProcessCopiedReportMarkdown } from "./index.js";

describe("chatgpt_chat action", () => {
  beforeEach(() => {
    rs.clearAllMocks();
    rs.restoreAllMocks();
    loadCachedScriptSourceMock.mockResolvedValue("// browser script");
    buildBrowserScriptExpressionMock.mockImplementation(
      ({ entrypointExpression }: { entrypointExpression: string }) =>
        `expression:${entrypointExpression}`,
    );
    acquireChatGPTClipboardLockMock.mockResolvedValue({
      release: rs.fn().mockResolvedValue(undefined),
    });
  });

  it("returns markdown copied from the ChatGPT response toolbar", async () => {
    const session = {
      send: rs.fn().mockResolvedValue(undefined),
      evaluateByValue: rs
        .fn()
        .mockResolvedValueOnce({
          prompt: "test",
          responseText: "Test\n\nalpha\n\nbeta",
          sources: [{ title: "Example", url: "https://example.com" }],
          timestamp: "2026-03-16T00:00:00.000Z",
        })
        .mockResolvedValueOnce({ complete: true })
        .mockResolvedValueOnce({ copyConfirmed: true }),
    };
    const close = rs.fn().mockResolvedValue(undefined);
    const release = rs.fn().mockResolvedValue(undefined);
    openDiscoveredPageSessionMock.mockResolvedValue({ session, close });
    acquireChatGPTClipboardLockMock.mockResolvedValue({ release });

    const readClipboardText = rs
      .fn()
      .mockResolvedValueOnce("old clipboard")
      .mockResolvedValueOnce("# Test\n\n* alpha\n* beta");
    const action = createActionForTest(readClipboardText);

    const result = await action.execute({ prompt: "test" });

    expect(openDiscoveredPageSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      "https://chatgpt.com/",
    );
    expect(buildBrowserScriptExpressionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entrypointExpression: "chatWithChatGPT",
        args: [{ prompt: "test", timeout: 1_800_000 }],
        autorunFlag: "__ROME_CHATGPT_CHAT_AUTORUN__",
      }),
    );
    expect(buildBrowserScriptExpressionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entrypointExpression: "waitForLatestChatGPTResponseComplete",
        args: [{ timeout: 5_000 }],
        autorunFlag: "__ROME_CHATGPT_CHECK_RESPONSE_COMPLETE_AUTORUN__",
      }),
    );
    expect(buildBrowserScriptExpressionMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        entrypointExpression: "copyLatestChatGPTResponse",
        autorunFlag: "__ROME_CHATGPT_COPY_RESPONSE_AUTORUN__",
      }),
    );
    expect(session.evaluateByValue).toHaveBeenNthCalledWith(1, "expression:chatWithChatGPT");
    expect(session.evaluateByValue).toHaveBeenNthCalledWith(
      2,
      "expression:waitForLatestChatGPTResponseComplete",
    );
    expect(session.evaluateByValue).toHaveBeenNthCalledWith(
      3,
      "expression:copyLatestChatGPTResponse",
    );
    expect(session.send).toHaveBeenCalledWith("Page.bringToFront");
    expect(readClipboardText).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "ok",
      data: "# Test\n\n* alpha\n* beta",
    });
  });

  it("post-processes copied markdown before returning it", async () => {
    const session = {
      send: rs.fn().mockResolvedValue(undefined),
      evaluateByValue: rs
        .fn()
        .mockResolvedValueOnce({
          prompt: "test",
          responseText: buildLongReportBody(),
          sources: [],
          timestamp: "2026-03-16T00:00:00.000Z",
        })
        .mockResolvedValueOnce({ complete: true })
        .mockResolvedValueOnce({ copyConfirmed: true }),
    };
    const close = rs.fn().mockResolvedValue(undefined);
    openDiscoveredPageSessionMock.mockResolvedValue({ session, close });

    const readClipboardText = rs
      .fn()
      .mockResolvedValueOnce("old clipboard")
      .mockResolvedValueOnce(`${buildLongReportBody()}

If it helps, I can rewrite this as a compact executive summary.

[1]: https://example.com/source`);
    const action = createActionForTest(readClipboardText);

    const result = await action.execute({ prompt: "test" });

    expect(result).toEqual({
      status: "ok",
      data: `${buildLongReportBody()}

[1]: https://example.com/source`,
    });
  });

  it("falls back to scraped text while a response is still incomplete", async () => {
    const warnSpy = rs.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: rs.fn().mockResolvedValue(undefined),
      evaluateByValue: rs
        .fn()
        .mockResolvedValueOnce({
          prompt: "test",
          responseText: "partial response",
          sources: [],
          timestamp: "2026-03-16T00:00:00.000Z",
        })
        .mockResolvedValueOnce({ complete: false }),
    };
    const close = rs.fn().mockResolvedValue(undefined);
    openDiscoveredPageSessionMock.mockResolvedValue({ session, close });

    const readClipboardText = rs.fn().mockResolvedValue("existing clipboard");
    const action = createActionForTest(readClipboardText);

    const result = await action.execute({ prompt: "test", timeout: 1000 });

    expect(session.evaluateByValue).toHaveBeenCalledTimes(2);
    expect(acquireChatGPTClipboardLockMock).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith("Page.bringToFront");
    expect(readClipboardText).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[chatgpt_chat] incomplete response fell back to scraped text",
      expect.stringContaining('"responsePreview":"partial response"'),
    );
    expect(result).toEqual({
      status: "ok",
      data: {
        response: "partial response",
        sources: [],
      },
    });
  });

  it("retries copy once before using the changed clipboard", async () => {
    const session = {
      send: rs.fn().mockResolvedValue(undefined),
      evaluateByValue: rs
        .fn()
        .mockResolvedValueOnce({
          prompt: "test",
          responseText: "plain text",
          sources: [],
          timestamp: "2026-03-16T00:00:00.000Z",
        })
        .mockResolvedValueOnce({ complete: true })
        .mockResolvedValueOnce({ copyConfirmed: false })
        .mockResolvedValueOnce({ copyConfirmed: false }),
    };
    const close = rs.fn().mockResolvedValue(undefined);
    openDiscoveredPageSessionMock.mockResolvedValue({ session, close });

    const readClipboardText = rs
      .fn()
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("# Test\n\n* alpha\n* beta");
    const action = createActionForTest(readClipboardText);

    const result = await action.execute({ prompt: "test" });

    expect(session.evaluateByValue).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "ok",
      data: "# Test\n\n* alpha\n* beta",
    });
  });

  it("waits for clipboard settlement, then retries the copy button once before releasing the lock", async () => {
    rs.useFakeTimers();
    try {
      const session = {
        send: rs.fn().mockResolvedValue(undefined),
        evaluateByValue: rs
          .fn()
          .mockResolvedValueOnce({
            prompt: "test",
            responseText: "plain text",
            sources: [],
            timestamp: "2026-03-16T00:00:00.000Z",
          })
          .mockResolvedValueOnce({ complete: true })
          .mockResolvedValueOnce({ copyConfirmed: true })
          .mockResolvedValueOnce({ copyConfirmed: true }),
      };
      const close = rs.fn().mockResolvedValue(undefined);
      const release = rs.fn().mockResolvedValue(undefined);
      openDiscoveredPageSessionMock.mockResolvedValue({ session, close });
      acquireChatGPTClipboardLockMock.mockResolvedValue({ release });

      const readClipboardText = rs
        .fn()
        .mockResolvedValueOnce("stable clipboard")
        .mockResolvedValueOnce("stable clipboard")
        .mockResolvedValueOnce("stable clipboard")
        .mockResolvedValueOnce("# Test\n\n* alpha\n* beta");
      const action = createActionForTest(readClipboardText);

      const resultPromise = action.execute({ prompt: "test" });
      await rs.runAllTimersAsync();
      const result = await resultPromise;

      expect(session.evaluateByValue).toHaveBeenCalledTimes(4);
      expect(readClipboardText).toHaveBeenCalledTimes(4);
      expect(release).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: "ok",
        data: "# Test\n\n* alpha\n* beta",
      });
      expect(readClipboardText.mock.invocationCallOrder[2]).toBeLessThan(
        session.evaluateByValue.mock.invocationCallOrder[3],
      );
      expect(session.evaluateByValue.mock.invocationCallOrder[3]).toBeLessThan(
        readClipboardText.mock.invocationCallOrder[3],
      );
      expect(readClipboardText.mock.invocationCallOrder[3]).toBeLessThan(
        release.mock.invocationCallOrder[0],
      );
    } finally {
      rs.useRealTimers();
    }
  });

  it("returns scraped text and sources when markdown copy is not confirmed", async () => {
    const warnSpy = rs.spyOn(console, "warn").mockImplementation(() => {});
    const session = {
      send: rs.fn().mockResolvedValue(undefined),
      evaluateByValue: rs
        .fn()
        .mockResolvedValueOnce({
          prompt: "test",
          responseText: "plain text",
          sources: [{ title: "Example", url: "https://example.com" }],
          timestamp: "2026-03-16T00:00:00.000Z",
        })
        .mockResolvedValueOnce({ complete: true })
        .mockResolvedValueOnce({ copyConfirmed: false })
        .mockResolvedValueOnce({ copyConfirmed: false }),
    };
    const close = rs.fn().mockResolvedValue(undefined);
    openDiscoveredPageSessionMock.mockResolvedValue({ session, close });

    const action = createActionForTest(rs.fn().mockResolvedValue("same clipboard"));

    const result = await action.execute({ prompt: "test" });

    expect(close).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[chatgpt_chat] complete response fell back to scraped text",
      expect.stringContaining('"copyConfirmed":false'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[chatgpt_chat] complete response fell back to scraped text",
      expect.stringContaining('"clipboardChanged":false'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[chatgpt_chat] complete response fell back to scraped text",
      expect.stringContaining('"responsePreview":"plain text"'),
    );
    expect(result).toEqual({
      status: "ok",
      data: {
        response: "plain text",
        sources: [{ title: "Example", url: "https://example.com" }],
      },
    });
  });

  it("releases the lock after reading the final clipboard contents and before closing the page", async () => {
    const readClipboardText = rs
      .fn()
      .mockResolvedValueOnce("old clipboard")
      .mockResolvedValueOnce("# Test\n\n* alpha\n* beta");
    const session = {
      send: rs.fn().mockResolvedValue(undefined),
      evaluateByValue: rs
        .fn()
        .mockResolvedValueOnce({
          prompt: "test",
          responseText: "Test\n\nalpha\n\nbeta",
          sources: [],
          timestamp: "2026-03-16T00:00:00.000Z",
        })
        .mockResolvedValueOnce({ complete: true })
        .mockResolvedValueOnce({ copyConfirmed: true }),
    };
    const close = rs.fn().mockResolvedValue(undefined);
    const release = rs.fn().mockResolvedValue(undefined);
    openDiscoveredPageSessionMock.mockResolvedValue({ session, close });
    acquireChatGPTClipboardLockMock.mockResolvedValue({ release });

    const action = createActionForTest(readClipboardText);

    await action.execute({ prompt: "test" });

    expect(acquireChatGPTClipboardLockMock.mock.invocationCallOrder[0]).toBeLessThan(
      session.send.mock.invocationCallOrder[0],
    );
    expect(session.send.mock.invocationCallOrder[0]).toBeLessThan(
      session.evaluateByValue.mock.invocationCallOrder[1],
    );
    expect(session.evaluateByValue.mock.invocationCallOrder[1]).toBeLessThan(
      readClipboardText.mock.invocationCallOrder[0],
    );
    expect(readClipboardText.mock.invocationCallOrder[0]).toBeLessThan(
      session.evaluateByValue.mock.invocationCallOrder[2],
    );
    expect(session.evaluateByValue.mock.invocationCallOrder[2]).toBeLessThan(
      readClipboardText.mock.invocationCallOrder[1],
    );
    expect(readClipboardText.mock.invocationCallOrder[1]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it("removes a trailing offer paragraph before references for long copied reports", () => {
    const markdown = `${buildLongReportBody()}

If you want, I can turn this into the same report format you use elsewhere, with explicit fields like "evidence," "confidence," and "what's missing publicly."

[1]: https://example.com/one
[2]: https://example.com/two`;

    expect(postProcessCopiedReportMarkdown(markdown)).toBe(`${buildLongReportBody()}

[1]: https://example.com/one
[2]: https://example.com/two`);
  });

  it("removes a trailing offer paragraph without references for long copied reports", () => {
    const markdown = `${buildLongReportBody()}

If useful, I can condense this into a one-page summary for leadership.`;

    expect(postProcessCopiedReportMarkdown(markdown)).toBe(buildLongReportBody());
  });

  it('removes a trailing paragraph that starts with "I can turn" on long copied reports', () => {
    const markdown = `${buildLongReportBody()}

I can turn this into the same report format you use elsewhere, with explicit fields like "evidence," "confidence," and "what's missing publicly."`;

    expect(postProcessCopiedReportMarkdown(markdown)).toBe(buildLongReportBody());
  });

  it('removes a trailing paragraph that starts with "I can also turn" before references on long copied reports', () => {
    const markdown = `${buildLongReportBody()}

I can also turn this into a compact investor memo with the same evidence structure.

[1]: https://example.com/one
[2]: https://example.com/two`;

    expect(postProcessCopiedReportMarkdown(markdown)).toBe(`${buildLongReportBody()}

[1]: https://example.com/one
[2]: https://example.com/two`);
  });

  it("keeps a trailing offer paragraph on short copied reports", () => {
    const markdown = `Short report paragraph.

If needed, I can expand this into a longer memo.`;

    expect(postProcessCopiedReportMarkdown(markdown)).toBe(markdown);
  });
});

function createActionForTest(readClipboardText?: () => Promise<string>) {
  return createChatGPTChatAction(
    {
      name: "chatgpt_chat",
      type: "custom",
      description: "Chat with ChatGPT",
      complexity: "moderate",
      speed: "slow",
      reliability: "medium",
      sideEffects: "write",
    },
    {
      capabilityDiscovery: {} as never,
      readClipboardText,
    },
  );
}

function buildLongReportBody(): string {
  return Array.from(
    { length: 8 },
    (_, index) =>
      `Paragraph ${index + 1}. This report section summarizes market positioning, customer signals, distribution evidence, product capabilities, buyer fit, and public proof points in enough detail to exceed the heuristic threshold without depending on references or generated boilerplate.`,
  ).join("\n\n");
}

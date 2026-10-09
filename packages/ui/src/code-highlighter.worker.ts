// Worker half of code-highlighter.ts: runs the stock @streamdown/code plugin
// and posts each result back.

import { code } from "@streamdown/code";
import type { CodeHighlighterPlugin } from "streamdown";
import type { HighlightRequest, HighlightResponse } from "./code-highlighter.js";

// The package compiles against the DOM lib, whose global postMessage is the
// window overload. In a worker it takes the message alone.
const scope = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<HighlightRequest>) => void,
  ): void;
  postMessage(message: HighlightResponse): void;
};

const plugin: CodeHighlighterPlugin = code;

scope.addEventListener("message", ({ data: { id, options } }) => {
  const reply = (result: HighlightResponse["result"]) => {
    // grammarState carries tokenizer internals the page never reads.
    const { grammarState: _grammarState, ...rest } = result as typeof result & {
      grammarState?: unknown;
    };
    scope.postMessage({ id, result: rest });
  };
  const result = plugin.highlight(options, reply);
  if (result) reply(result);
});

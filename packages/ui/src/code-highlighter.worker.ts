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

type Result = NonNullable<HighlightResponse["result"]>;

const plugin: CodeHighlighterPlugin = code;

function reply(id: number, result: Result | null) {
  if (!result) {
    scope.postMessage({ id, result: null });
    return;
  }
  // grammarState carries tokenizer internals the page never reads.
  const { grammarState: _grammarState, ...rest } = result as Result & { grammarState?: unknown };
  scope.postMessage({ id, result: rest });
}

scope.addEventListener("message", ({ data: { id, options } }) => {
  let answered = false;
  const answer = (result: Result | null) => {
    if (answered) return;
    answered = true;
    reply(id, result);
  };
  try {
    const result = plugin.highlight(options, answer);
    if (result) answer(result);
  } catch {
    answer(null);
  }
});

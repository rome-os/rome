import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@rome-os/app-runtime";

// welcome-to-rome renders its OWN inline chat components (declared in app.yaml's
// `components:`), not the builtin `ask_question` card. A scripted turn emits the
// app-owned inline suspension — note: NO `builtin` flag, and `appId`
// is this app. The component's `ctx.host.submit(output)` comes back as the next
// turn's prompt (parsed via readResolutionJson).
const APP_ID = "welcome-to-rome";
const TOOL = "welcome_card";

export function emitComponent(
  emit: (event: AgentMessage) => void,
  componentId: string,
  props: Record<string, unknown>,
): void {
  const toolUseId = randomUUID();
  emit({ type: "tool_use", id: toolUseId, tool: TOOL, input: { componentId, props } });
  const payload = {
    pendingInteraction: true,
    appId: APP_ID,
    render: { kind: "inline", componentId, props },
  };
  emit({
    type: "tool_result",
    toolUseId,
    tool: TOOL,
    output: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

// The host's BUILT-IN question card (not an app-owned component). webchat's drain
// only trusts a `builtin: true` core card when the emitting tool is `ask_question`
// and it resolves to `appId: "core"` / `componentId: "question-card"`
// (packages/core/src/api/routes/webchat.ts), so a scripted turn reproduces the
// exact `ask_question` facade output. Answers return next turn as
// `{ answers: [{ questionId, value }] }` (parsed via readResolutionJson).
const ASK_QUESTION_TOOL = "ask_question";

/** One question in a built-in ask_question card. Mirrors the core facade schema
 *  (packages/core/src/core/mcp-facade.ts). */
export interface AskQuestion {
  /** Stable id; the answer references it. */
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  /** Required for single/multi; the choices. Ignored for text. */
  options?: string[];
  /** single/multi: also show a free-text box beneath the options. */
  freeText?: boolean;
  /** If true, the guardian may leave it blank without blocking submit. */
  optional?: boolean;
}

export function emitAskQuestion(
  emit: (event: AgentMessage) => void,
  questions: AskQuestion[],
): void {
  const toolUseId = randomUUID();
  emit({ type: "tool_use", id: toolUseId, tool: ASK_QUESTION_TOOL, input: { questions } });
  const payload = {
    pendingInteraction: true,
    appId: "core",
    render: { kind: "inline", componentId: "question-card", props: { questions }, builtin: true },
  };
  emit({
    type: "tool_result",
    toolUseId,
    tool: ASK_QUESTION_TOOL,
    output: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

// The host's BUILT-IN connect-AI card (rome-web's ai-tools-card). The webchat
// drain trusts it only when the emitting tool is `connect_ai`
// (packages/core/src/api/routes/webchat.ts). It resolves next turn as
// `{ connected: true }` or `{ skip: true }` (parsed via readResolutionJson).
const CONNECT_AI_TOOL = "connect_ai";

export function emitConnectAi(emit: (event: AgentMessage) => void): void {
  const toolUseId = randomUUID();
  emit({ type: "tool_use", id: toolUseId, tool: CONNECT_AI_TOOL, input: {} });
  const payload = {
    pendingInteraction: true,
    appId: "core",
    render: { kind: "inline", componentId: "ai-tools-card", props: {}, builtin: true },
  };
  emit({
    type: "tool_result",
    toolUseId,
    tool: CONNECT_AI_TOOL,
    output: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

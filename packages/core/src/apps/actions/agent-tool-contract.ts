// For the tests of core's agent tools (agent-tool.ts): the suite of who may
// ask, which every tool enrolls in by its sideEffects, and the call a tool's
// own tests make, so a tool's tests cover only its operation.

import { describe, expect, it } from "@rstest/core";
import type { Action, ActionResult } from "@rome-os/app-runtime";
import type { AgentTool, ToolTurn } from "./agent-tool.js";
import { actionExecutionContext } from "./context.js";
import { type OwnerOfChat, whoMayAsk } from "./who-may-ask.js";

/** The guardian's own message in their private chat, which may call any tool. */
export const GUARDIAN_TURN: ToolTurn = {
  actor: { kind: "guardian", userId: "guardian", via: "cookie" },
  audience: "private",
  channelContext: { channel: "webchat", threadId: "guardian-chat" },
};

const owners: Record<string, string> = {
  "guardian-chat": "guardian",
  "visitor-chat": "visitor:visitor",
};
const ownerOfChat: OwnerOfChat = async (chatId) => owners[chatId] ?? null;

/** The action core registers for `tool` over `deps`, in a Rome where
 * "guardian-chat" is the guardian's chat and "visitor-chat" a visitor's. */
export function actionOf<D>(tool: AgentTool<D>, deps: D): Action {
  return tool.action(deps, whoMayAsk(ownerOfChat));
}

/** Calls `tool` over `deps` as the action core registers, for `turn`. */
export function callTool<D>(
  tool: AgentTool<D>,
  deps: D,
  input: Record<string, unknown>,
  turn: ToolTurn = GUARDIAN_TURN,
): Promise<ActionResult> {
  const action = actionOf(tool, deps);
  return asTurn(turn, () => action.execute(input));
}

const visitor = { kind: "visitor", accountId: "visitor", email: "v@example.test" } as const;
const guardianCookie = GUARDIAN_TURN.actor;
const guardianLoopback = { kind: "guardian", userId: "guardian", via: "loopback" } as const;

/** Each turn the suite asks from, with the code of the refusal it gets by the
 * tool's sideEffects, or null where the tool runs. */
const CASES: ReadonlyArray<{
  name: string;
  turn: ToolTurn;
  "read-only": string | null;
  write: string | null;
}> = [
  {
    name: "the guardian's own message in their private chat",
    turn: GUARDIAN_TURN,
    "read-only": null,
    write: null,
  },
  {
    name: "the guardian's own message in a shared chat",
    turn: { ...GUARDIAN_TURN, audience: "shared" },
    "read-only": null,
    write: "private_only",
  },
  {
    name: "a turn no one started in the guardian's private chat, such as a routine's",
    turn: { audience: "private", channelContext: GUARDIAN_TURN.channelContext },
    "read-only": null,
    write: "needs_guardian",
  },
  {
    name: "the guardian through loopback rather than their signed-in session",
    turn: { ...GUARDIAN_TURN, actor: guardianLoopback },
    "read-only": null,
    write: "needs_guardian",
  },
  {
    name: "a turn no one started in a chat on a connection",
    turn: { channelContext: { channel: "slack", threadId: "C1" } },
    "read-only": null,
    write: "private_only",
  },
  {
    name: "a visitor",
    turn: { actor: visitor, audience: "private", channelContext: GUARDIAN_TURN.channelContext },
    "read-only": "guardian_only",
    write: "needs_guardian",
  },
  {
    name: "a turn no one started in a visitor's chat",
    turn: { channelContext: { channel: "webchat", threadId: "visitor-chat" } },
    "read-only": "guardian_only",
    write: "private_only",
  },
  {
    name: "the guardian in a chat that no longer exists",
    turn: { actor: guardianCookie, channelContext: { channel: "webchat", threadId: "gone" } },
    "read-only": "guardian_only",
    write: "private_only",
  },
  {
    name: "a turn with no one and no chat",
    turn: {},
    "read-only": "guardian_only",
    write: "private_only",
  },
];

/**
 * The tests of who may ask for `tool`, by its sideEffects. A refused turn gets
 * the refusal and `run` never reaches `deps`; any other turn passes the check.
 * `input` is any input that fits the tool.
 */
export function whoMayAskSuite(tool: AgentTool<never>, input: Record<string, unknown>): void {
  describe(`who may ask for ${tool.name}`, () => {
    for (const c of CASES) {
      const code = c[tool.sideEffects];
      it(`${code ? `refuses (${code})` : "lets through"} ${c.name}`, async () => {
        const touched: string[] = [];
        const deps = new Proxy(
          {},
          {
            get: (_target, key) => {
              touched.push(String(key));
              throw new Error("run reached its deps");
            },
          },
        ) as never;
        const check = whoMayAsk(ownerOfChat);
        let verdict: string | null | undefined;
        const action = tool.action(deps, async (asked, turn) => {
          verdict = await check(asked, turn);
          return verdict;
        });
        // A turn let through runs into the deps, which throw.
        const result = await asTurn(c.turn, () => action.execute(input)).catch(() => null);
        if (code) {
          expect(result).toEqual({ status: "error", error: verdict });
          expect(verdict).toMatch(new RegExp(`^${code}: .*${tool.name}`));
          expect(touched).toEqual([]);
        } else {
          expect(verdict).toBeNull();
        }
      });
    }
  });
}

function asTurn<T>(turn: ToolTurn, fn: () => Promise<T>): Promise<T> {
  return actionExecutionContext.run(
    { executionId: "exec", rootExecutionId: "exec", initiator: "test", ...turn },
    fn,
  );
}

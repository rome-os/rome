import { describe, expect, it } from "@rstest/core";
import type {
  NotifyContent as CoreNotifyContent,
  SendOutcome as CoreSendOutcome,
} from "../lib/notify-client.js";
// The `send_notification` action re-declares these types structurally because a
// rome_app cannot import `@rome/core`. This core-side test closes the loop the
// action package can't: it imports both copies and asserts they are identical.
// (Same core-test → rome_apps import direction as `defer-resume.test.ts`.)
import type {
  NotifyContent as ActionNotifyContent,
  SendOutcome as ActionSendOutcome,
} from "../../../../rome_apps/system/src/actions/send-notification/index.js";

// Exact type equality (invariant), NOT mere mutual assignability. Bidirectional
// `extends` would treat `{ body?: string }` and `{ body?: string; subtitle?: string }`
// as equal — an added/removed OPTIONAL field would slip through. This standard
// `Equal` compares the types identically, so any drift (a renamed/added/removed
// field or variant, optional or required, on either side) resolves to `false`
// and fails `tsc --noEmit`. Compile-time guard; Rstest only runs the trivial
// assertion below.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const _sendOutcomeInSync: Equal<CoreSendOutcome, ActionSendOutcome> = true;
const _notifyContentInSync: Equal<CoreNotifyContent, ActionNotifyContent> = true;
void _sendOutcomeInSync;
void _notifyContentInSync;

describe("send_notification structural copy", () => {
  it("stays field-for-field in sync with core (enforced at typecheck)", () => {
    // The real guard is the two compile-time constants above; a drift fails
    // `pnpm typecheck`, not this runtime assertion. This keeps the file a
    // runnable Rstest suite.
    expect(true).toBe(true);
  });
});

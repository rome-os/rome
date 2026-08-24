import type { MessageBoxOptions } from "electron";
import type { UpdateStatus } from "./updater";

/** The button that installs, when the dialog offers one. */
export const RESTART_BUTTON = 0;

/**
 * What the "Check for Updates…" menu item says when the check comes back.
 *
 * The manager already writes a sentence for every state it can reach, so this
 * carries it rather than composing a second one that could disagree. Two states
 * need more than the sentence:
 *
 * `error` — the message is deliberately vague and the cause sits in `error`,
 * which becomes the detail.
 *
 * `downloaded` — a check in this state returns early without doing anything,
 * so a lone OK would answer "ready to install" with no way to install. The
 * automatic prompt offers Restart Now; asking on purpose should not offer less.
 *
 * `available` is not a state this ever sees — `update-available` starts the
 * download in the same tick, so a resolved check reads `downloading`.
 */
export function updateDialogFor(status: UpdateStatus): MessageBoxOptions {
  if (status.state === "error") {
    return {
      type: "warning",
      message: status.message,
      detail: status.error ?? undefined,
      buttons: ["OK"],
    };
  }
  if (status.state === "downloaded") {
    return {
      type: "info",
      message: status.message,
      detail: "Restart Rome now to finish installing, or install it the next time you quit.",
      buttons: ["Restart Now", "Later"],
      defaultId: RESTART_BUTTON,
      cancelId: 1,
    };
  }
  return { type: "info", message: status.message, buttons: ["OK"] };
}

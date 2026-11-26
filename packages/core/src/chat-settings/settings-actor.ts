// Who a chat's settings record as having written them, from whoever a command
// or a press on a connection was let in as
// (docs/domains/participation.md#entry).

import type { SettingsActor } from "@rome-os/app-runtime";

/** Whom a command or a press was let in as: the guardian, or a member signed
 *  in as a visitor. */
export interface LetInAs {
  readonly kind: "guardian" | "visitor";
}

const SETTINGS_KIND = { guardian: "guardian", visitor: "member" } as const;

/** The kind of settings actor `by` is recorded as. */
export function settingsKindOf(by: LetInAs): "guardian" | "member" {
  return SETTINGS_KIND[by.kind];
}

/** The settings actor for `by`, named `id` where the connection names them. */
export function settingsActorOf(by: LetInAs, id: string): SettingsActor {
  return { kind: settingsKindOf(by), id };
}

// Personal-data actions: the actions that read data about the guardian that
// only they should see. They run only in a private turn. Domain:
// docs/domains/participation.md#audience. Concept: docs/user-data.md.

/** By canonical id, so no app's action of the same local name joins by accident. */
const PERSONAL_DATA_ACTIONS: ReadonlySet<string> = new Set([
  "core:user_data_catalog",
  "core:user_data_query",
]);

export function isPersonalDataAction(name: string): boolean {
  return PERSONAL_DATA_ACTIONS.has(name);
}

/** The error a personal-data action returns outside a private turn. */
export const PERSONAL_DATA_PRIVATE_ONLY =
  "personal_data_private_only: This chat is not private, so personal data (Apple Health and other " +
  "synced data) cannot be read here. Ask the guardian to ask you in a private chat with Rome, such " +
  "as the Rome app or a direct message.";

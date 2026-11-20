import type { TFunction } from "i18next";

/** The names a secret-access preview asks for. Previews stored before several names carry `name` alone. */
export function secretNames(preview: { name: string; names?: string[] }): string[] {
  return preview.names?.length ? preview.names : [preview.name];
}

/** The names as one line, joined the way the language joins a list. */
export function secretNamesText(
  t: TFunction<"chat">,
  preview: { name: string; names?: string[] },
): string {
  return secretNames(preview).join(t("approvals.secretAccess.separator"));
}

import { useTranslation } from "react-i18next";
import type { SystemInputSource } from "@rome/api-types/trace-segments";

/**
 * The quiet look of the line under a message that says where its turn came
 * from, as the iOS app draws it: about a spacing step from its bubble, faint,
 * cut short when long.
 */
const SOURCE_LINE =
  "-mt-1 mb-1 flex max-w-full min-w-0 items-center gap-1 px-3 text-aux text-muted-foreground/75";

/**
 * Where a message's turn came from, such as "Routine · Daily summary", under a
 * message the Concierge said on its own, from a routine, an app, another agent
 * or what it follows: text, not a control.
 */
export function SourceLabel({ source }: { source: SystemInputSource }) {
  const { t } = useTranslation("chat");
  const kind = t(`automatedInput.kinds.${source.type}`);
  const name = source.name ? t("automatedInput.named", { kind, name: source.name }) : kind;
  return (
    <p data-source-label={source.type} title={name} className={SOURCE_LINE}>
      <span className="max-w-56 truncate">{name}</span>
    </p>
  );
}

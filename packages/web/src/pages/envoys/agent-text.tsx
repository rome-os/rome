import { Trans, useTranslation } from "react-i18next";

/** A sentence from the envoys namespace whose `<agent>` tag sets an agent's
 *  name in monospace, so a name such as main does not read as a plain word. */
export function AgentText({ k, values }: { k: string; values: Record<string, unknown> }) {
  const { t } = useTranslation("envoys");
  return (
    <Trans
      t={t}
      i18nKey={k}
      values={values}
      components={{ agent: <span className="font-mono" /> }}
    />
  );
}

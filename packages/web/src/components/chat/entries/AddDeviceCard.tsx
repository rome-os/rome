import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addDeviceCardPropsSchema } from "@rome/api-types/add-device-card";
import {
  DeviceConnectionContent,
  type SetupMethod,
  SetupMethodBadge,
  setupMethods,
} from "@/components/device-connection-cards";
import { Button } from "@/components/ui/button";
import { useDevicesQuery } from "@/hooks/use-devices-query";

// `system:add_device`'s card: the ways to add a device and their instructions,
// as the Devices page's Link device menu and dialog show them, from the same
// components. It answers `{ added: true, deviceId, name }` once a device the
// props do not list is linked, and is dismissed by a typed reply like core's
// other cards (chat-view.ts).

export interface AddDeviceCardProps {
  toolUseId: string;
  /** The card's props as core sent them. */
  props: unknown;
  /** Prior submitted output when this instance already resolved. */
  result?: Record<string, unknown>;
  onSubmit: (
    toolUseId: string,
    output: Record<string, unknown>,
    summary?: string,
  ) => void | Promise<void>;
}

interface Submission {
  output: Record<string, unknown>;
  summary: string;
}

export function AddDeviceCard({ toolUseId, props, result, onSubmit }: AddDeviceCardProps) {
  const { t } = useTranslation("chat");
  const { t: tSettings } = useTranslation("settings", { keyPrefix: "devices.setup" });
  const [method, setMethod] = useState<SetupMethod | null>(null);
  const [sent, setSent] = useState<Submission | null>(null);
  const [failed, setFailed] = useState<Submission | null>(null);
  const resolved = result !== undefined || sent !== null;
  const parsed = addDeviceCardPropsSchema.safeParse(props);
  const known = parsed.success ? parsed.data.deviceIds : undefined;
  const devices = useDevicesQuery({ enabled: !resolved && !failed && known !== undefined });
  const added = known && devices.data?.devices.find((device) => !known.includes(device.id));

  const submit = useCallback(
    (submission: Submission) => {
      setSent(submission);
      setFailed(null);
      Promise.resolve(onSubmit(toolUseId, submission.output, submission.summary)).catch(() => {
        setSent(null);
        setFailed(submission);
      });
    },
    [onSubmit, toolUseId],
  );

  useEffect(() => {
    if (!added || resolved || failed) return;
    submit({
      output: { added: true, deviceId: added.id, name: added.name },
      summary: t("addDeviceCard.addedSummary", { name: added.name }),
    });
  }, [added, resolved, failed, submit, t]);

  const answer = result ?? sent?.output;
  const addedName = answer?.added === true && typeof answer.name === "string" ? answer.name : null;

  return (
    <div
      tabIndex={-1}
      data-chat-pending-card={!resolved ? "" : undefined}
      className="mb-4 rounded-12 border border-border bg-surface"
    >
      <div className="p-4">
        <p className="text-ui text-foreground">{tSettings("title")}</p>
        {!resolved && (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {setupMethods.map((choice) => (
                <Button
                  key={choice}
                  type="button"
                  size="sm"
                  variant={choice === method ? "secondary" : "outline"}
                  aria-pressed={choice === method}
                  onClick={() => setMethod(choice)}
                >
                  {tSettings(`methods.${choice}`)}
                </Button>
              ))}
            </div>
            {method && (
              <div className="mt-4 space-y-4">
                <SetupMethodBadge method={method} />
                <DeviceConnectionContent method={method} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-aux text-muted-foreground">
          {failed && !resolved
            ? t("aiToolsCard.sendFailed")
            : addedName !== null
              ? t("addDeviceCard.added", { name: addedName })
              : resolved
                ? t("addDeviceCard.dismissed")
                : known !== undefined
                  ? t("addDeviceCard.waiting")
                  : null}
        </span>
        {failed && !resolved && (
          <Button type="button" size="sm" onClick={() => submit(failed)}>
            {t("aiToolsCard.retry")}
          </Button>
        )}
      </div>
    </div>
  );
}

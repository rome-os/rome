import { useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CHECK_DEVICES_EVENT,
  DISMISS_ADD_DEVICE_EVENT,
  addDeviceCardPropsSchema,
} from "@rome/api-types/add-device-card";
import {
  DeviceConnectionContent,
  type SetupMethod,
  SetupMethodBadge,
  setupMethods,
} from "@/components/device-connection-cards";
import { Button } from "@/components/ui/button";
import { useDeviceListQuery } from "@/hooks/use-devices-query";
import { postWidgetEvent, type WidgetEventOutcome } from "@/lib/chat-api";
import { WidgetHostContext } from "./widget-ui/turn-fields";

// `system:add_device`'s card: the ways to add a device and their instructions,
// as the Devices page's Link device menu and dialog show them, from the same
// components. Core answers it (api/routes/widget-events.ts): the card sends
// `check` once it sees a device the props do not list, and Not now sends
// `dismiss`. A typed reply dismisses it like core's other cards (chat-view.ts).

export interface AddDeviceCardProps {
  /** The widget's id: the id of the message that holds the card. */
  widgetId: string;
  /** The card's props as core sent them. */
  props: unknown;
  /** The stored answer once the card is answered or dismissed. */
  result?: Record<string, unknown>;
  /** Sends one of the card's events to core. */
  sendEvent?: (
    widgetId: string,
    body: { name: string; turn?: Record<string, unknown> },
  ) => Promise<WidgetEventOutcome>;
}

type Sent = { added: true; name: string } | { dismissed: true };

export function AddDeviceCard({
  widgetId,
  props,
  result,
  sendEvent = postWidgetEvent,
}: AddDeviceCardProps) {
  const { t } = useTranslation("chat");
  const { t: tSettings } = useTranslation("settings", { keyPrefix: "devices.setup" });
  const host = useContext(WidgetHostContext);
  const [method, setMethod] = useState<SetupMethod | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolved = result !== undefined || sent !== null;
  const parsed = addDeviceCardPropsSchema.safeParse(props);
  const known = parsed.success ? parsed.data.deviceIds : undefined;
  const live = !resolved && !host.readOnly;
  const devices = useDeviceListQuery({ enabled: live && !failed && known !== undefined });
  const added = known && devices.data?.devices.find((device) => !known.includes(device.id));

  const send = useCallback(
    async (name: string, answered: Sent) => {
      setBusy(true);
      setFailed(null);
      const outcome = await sendEvent(widgetId, { name, turn: host.turnFields() }).catch(
        (): WidgetEventOutcome => ({ ok: false, status: 0 }),
      );
      setBusy(false);
      host.onSettled?.(outcome);
      if (outcome.ok && outcome.answered) setSent(answered);
      else setFailed(name);
    },
    [host, sendEvent, widgetId],
  );

  useEffect(() => {
    if (!added || !live || failed || busy) return;
    void send(CHECK_DEVICES_EVENT, { added: true, name: added.name });
  }, [added, live, failed, busy, send]);

  const answer: Record<string, unknown> | undefined = result ?? sent ?? undefined;
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
        {live && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send(DISMISS_ADD_DEVICE_EVENT, { dismissed: true })}
            >
              {t("addDeviceCard.notNow")}
            </Button>
            {failed === CHECK_DEVICES_EVENT && added && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void send(CHECK_DEVICES_EVENT, { added: true, name: added.name })}
              >
                {t("aiToolsCard.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

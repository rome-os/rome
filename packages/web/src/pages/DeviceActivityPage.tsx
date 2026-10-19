import { NodeDeviceActivity } from "@rome-os/node-ui";
import { Page } from "@rome-os/ui/page";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { deviceHref, nodeConsoleUrl, useDevicesQuery } from "@/components/devices-section";

/**
 * One device's commands (`/settings/devices/:deviceId`). `?command=<id>` selects a command, so a
 * link from the Devices tab opens it and the back button closes it.
 */
export default function DeviceActivityPage() {
  const { t, i18n } = useTranslation("settings");
  const { deviceId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const devices = useDevicesQuery().data?.devices ?? [];
  const device = devices.find((item) => item.id.toLowerCase() === deviceId.toLowerCase()) ?? {
    id: deviceId,
    name: deviceId,
  };
  const command = Number(params.get("command"));
  return (
    <Page>
      <NodeDeviceActivity
        url={nodeConsoleUrl()}
        device={device}
        locale={i18n.language}
        selected={Number.isSafeInteger(command) && command > 0 ? command : null}
        onSelect={(id) =>
          setParams(id === null ? {} : { command: String(id) }, { replace: params.has("command") })
        }
        nav={
          <Link
            to={deviceHref(null)}
            className="inline-flex items-center gap-2 text-ui text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t("devices.title")}
          </Link>
        }
      />
    </Page>
  );
}

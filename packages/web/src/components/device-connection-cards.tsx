import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const setupMethods = ["desktop", "cli", "container"] as const;
type SetupMethod = (typeof setupMethods)[number];

function DeviceConnectionContent({ method }: { method: SetupMethod }) {
  const { t } = useTranslation("settings", { keyPrefix: "devices.setup" });
  if (method === "desktop") {
    return (
      <>
        <p className="text-ui text-muted-foreground">{t("desktopHelp")}</p>
        <Button variant="outline" size="sm" asChild>
          <a href="https://romeos.cc/download" target="_blank" rel="noopener noreferrer">
            {t("desktopDownload")}
          </a>
        </Button>
      </>
    );
  }

  if (method === "container") {
    return <p className="text-ui text-muted-foreground">{t("containerHelp")}</p>;
  }

  return (
    <>
      <p className="text-ui text-muted-foreground">{t("commandHelp")}</p>
      <pre className="overflow-x-auto rounded-8 bg-muted p-4 font-mono text-ui">
        <code>rome-node connect</code>
      </pre>
      <p className="text-ui text-muted-foreground">{t("access")}</p>
      <Button variant="outline" size="sm" asChild>
        <a
          href="https://github.com/rome-os/rome/blob/main/packages/rome-node-cli/README.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("instructions")}
        </a>
      </Button>
    </>
  );
}

export function DeviceConnectionCards() {
  const { t } = useTranslation("settings", { keyPrefix: "devices.setup" });
  return (
    <SettingsGroup title={t("title")} titleId="connect-device-title">
      <div className="flex flex-col gap-3">
        {setupMethods.map((method) => (
          <Card key={method}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{t(`methods.${method}`)}</CardTitle>
                {method === "container" && <Badge variant="muted">{t("comingSoon")}</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <DeviceConnectionContent method={method} />
            </CardContent>
          </Card>
        ))}
      </div>
    </SettingsGroup>
  );
}

export function LinkDeviceMenu() {
  const { t } = useTranslation("settings");
  const [method, setMethod] = useState<SetupMethod | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingGuide = useRef(false);
  const close = () => setMethod(null);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          {/* Leaves room for SettingsDialog's close button at mid-width viewports. */}
          <Button ref={trigger} size="sm" className="sm:max-lg:mr-10">
            <Plus data-icon="inline-start" aria-hidden />
            {t("devices.setup.linkDevice")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (openingGuide.current) event.preventDefault();
            openingGuide.current = false;
          }}
        >
          {setupMethods.map((choice) => (
            <DropdownMenuItem
              key={choice}
              onSelect={() => {
                openingGuide.current = true;
                setMethod(choice);
              }}
            >
              {t(`devices.setup.methods.${choice}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={method !== null}
        onClose={close}
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col"
        {...{
          onCloseAutoFocus: (event: Event) => {
            event.preventDefault();
            trigger.current?.focus();
          },
        }}
      >
        <DialogHeader onClose={close} closeLabel={t("common.close")}>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{method && t(`devices.setup.methods.${method}`)}</DialogTitle>
            {method === "container" && (
              <Badge variant="muted">{t("devices.setup.comingSoon")}</Badge>
            )}
          </div>
        </DialogHeader>
        <DialogBody className="min-h-0 space-y-4">
          {method && <DeviceConnectionContent method={method} />}
        </DialogBody>
      </Dialog>
    </>
  );
}

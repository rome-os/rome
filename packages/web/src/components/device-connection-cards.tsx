import { Section, SectionHeader, SectionHeading, SectionTitle } from "@rome-os/ui/page";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const methods = ["desktop", "cli", "container"] as const;
type Method = Exclude<(typeof methods)[number], "container">;
type OpenContainerSetup = (trigger: HTMLButtonElement) => void;

function DeviceConnectionContent({ method }: { method: Method }) {
  const { t } = useTranslation("settings", { keyPrefix: "devices.setup" });
  return (
    <>
      {method === "desktop" && (
        <>
          <p className="text-ui text-muted-foreground">{t("desktopHelp")}</p>
          <Button variant="outline" size="sm" asChild>
            <a href="https://romeos.cc/download" target="_blank" rel="noopener noreferrer">
              {t("desktopDownload")}
            </a>
          </Button>
        </>
      )}
      {method === "cli" && (
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
      )}
    </>
  );
}

export function DeviceConnectionCards({
  onContainerSetup,
}: {
  onContainerSetup: OpenContainerSetup;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "devices.setup" });
  return (
    <Section aria-labelledby="connect-device-title">
      <SectionHeader>
        <SectionHeading>
          <SectionTitle id="connect-device-title">{t("title")}</SectionTitle>
        </SectionHeading>
      </SectionHeader>
      {methods.map((method) => (
        <Card key={method}>
          <CardHeader>
            <CardTitle>{t(`methods.${method}`)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {method === "container" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={(event) => onContainerSetup(event.currentTarget)}
              >
                {t("containerSetup")}
              </Button>
            ) : (
              <DeviceConnectionContent method={method} />
            )}
          </CardContent>
        </Card>
      ))}
    </Section>
  );
}

export function LinkDeviceMenu({ onContainerSetup }: { onContainerSetup: OpenContainerSetup }) {
  const { t } = useTranslation("settings");
  const [method, setMethod] = useState<Method | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openingContainer = useRef(false);
  const close = () => setMethod(null);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button id="link-device" ref={trigger} size="sm" className="sm:max-lg:mr-10">
            <Plus data-icon="inline-start" aria-hidden />
            {t("devices.setup.linkDevice")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (method || openingContainer.current) event.preventDefault();
            openingContainer.current = false;
          }}
        >
          {methods.map((choice) => (
            <DropdownMenuItem
              key={choice}
              onSelect={() => {
                if (choice === "container") {
                  if (trigger.current) {
                    openingContainer.current = true;
                    onContainerSetup(trigger.current);
                  }
                } else {
                  setMethod(choice);
                }
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
          <DialogTitle>{method && t(`devices.setup.methods.${method}`)}</DialogTitle>
        </DialogHeader>
        <DialogBody className="min-h-0 space-y-4">
          {method && <DeviceConnectionContent method={method} />}
        </DialogBody>
      </Dialog>
    </>
  );
}

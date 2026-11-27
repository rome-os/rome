import { Check, Copy, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings-group";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";

const setupMethods = ["desktop", "cli", "container"] as const;
type SetupMethod = (typeof setupMethods)[number];

const CONTAINER_DOCS_URL =
  "https://github.com/rome-os/rome/blob/main/docs/rome-node.md#run-rome-node-with-docker";

export const ROME_NODE_DOCKER_COMPOSE = `services:
  rome-node:
    image: ghcr.io/rome-os/rome-node:latest
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    ports:
      - "127.0.0.1:4310:4310"
    # Optional: set a Web UI password for remote access.
    # environment:
    #   ROME_NODE_UI_PASSWORD: "your-custom-password"
    volumes:
      - rome-node:/var/lib/rome-node
volumes:
  rome-node:`;

function ContainerConnectionGuide() {
  const { t } = useTranslation("settings", { keyPrefix: "devices.setup" });
  const { copiedText, copy } = useCopyFeedback();
  const [copyRefused, setCopyRefused] = useState(false);
  const copied = copiedText === ROME_NODE_DOCKER_COMPOSE;

  async function handleCopy() {
    setCopyRefused(!(await copy(ROME_NODE_DOCKER_COMPOSE)));
  }

  return (
    <>
      <p className="text-ui text-muted-foreground">{t("containerHelp")}</p>
      <pre className="select-text overflow-x-auto rounded-8 bg-muted p-4 font-mono text-aux text-foreground">
        <code>{ROME_NODE_DOCKER_COMPOSE}</code>
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
          {copied ? (
            <Check data-icon="inline-start" aria-hidden className="text-success-fg" />
          ) : (
            <Copy data-icon="inline-start" aria-hidden />
          )}
          {copied ? t("copiedCompose") : t("copyCompose")}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={CONTAINER_DOCS_URL} target="_blank" rel="noopener noreferrer">
            {t("containerInstructions")}
          </a>
        </Button>
      </div>
      {copyRefused && (
        <p role="alert" className="text-aux text-destructive-fg">
          {t("copyComposeRefused")}
        </p>
      )}
    </>
  );
}

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
    return <ContainerConnectionGuide />;
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
              <CardTitle>{t(`methods.${method}`)}</CardTitle>
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
          <DialogTitle>{method && t(`devices.setup.methods.${method}`)}</DialogTitle>
        </DialogHeader>
        <DialogBody className="min-h-0 space-y-4">
          {method && <DeviceConnectionContent method={method} />}
        </DialogBody>
      </Dialog>
    </>
  );
}

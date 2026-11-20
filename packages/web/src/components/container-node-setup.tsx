import {
  type ContainerNodeAuthorization,
  type ContainerNodeCredential,
  containerNodeAuthorizationSchema,
  containerNodeCredentialSchema,
  containerNodeNameSchema,
} from "@rome/api-types/devices";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { apiErrorMessageFrom, getApiErrorMessage } from "@/lib/api-error";
import { parseSSEEvents } from "@/lib/chat-sse";
import romeNodeImage from "@/lib/rome-node-image.json";

const setupPath = "/api/devices/container-nodes";

function containerNodeCompose({ deviceId, deviceToken, origin }: ContainerNodeCredential) {
  const projectName = `rome-node-${deviceId.toLowerCase().replaceAll("-", "").slice(0, 20)}`;
  const address = JSON.stringify(origin.replaceAll("$", () => "$$"));
  return `name: "${projectName}"
services:
  rome-node:
    image: "${romeNodeImage.image}"
    restart: unless-stopped
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    volumes:
      - audit:/var/lib/rome-node
    environment:
      ROME_NODE_CLOUD_URL: ${address}
      ROME_NODE_DEVICE_ID: "${deviceId}"
      ROME_NODE_TOKEN: "${deviceToken}"
volumes:
  audit:
`;
}

async function authorizeCloudNode(
  name: string,
  signal: AbortSignal,
  onAuthorization: (authorization: ContainerNodeAuthorization) => void,
) {
  const response = await fetch(setupPath, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!response.ok) throw new Error(await getApiErrorMessage(response, "unavailable"));
  if (!response.body) throw new Error("unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("unavailable");
      buffer += decoder.decode(chunk.value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary < 0) continue;
      for (const { event, data } of parseSSEEvents(buffer.slice(0, boundary + 2))) {
        if (event === "authorization")
          onAuthorization(containerNodeAuthorizationSchema.parse(JSON.parse(data)));
        if (event === "credential") return containerNodeCredentialSchema.parse(JSON.parse(data));
        if (event === "authorization_error")
          throw new Error(apiErrorMessageFrom(JSON.parse(data), "unavailable"));
      }
      buffer = buffer.slice(boundary + 2);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function ContainerNodeSetup({
  trigger,
  onClose,
}: {
  trigger: HTMLButtonElement;
  onClose(): void;
}) {
  const { t } = useTranslation("settings");
  const { t: node } = useTranslation("settings", { keyPrefix: "devices.containerNodes" });
  const nameId = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(node("defaultName"));
  const [authorization, setAuthorization] = useState<ContainerNodeAuthorization | null>(null);
  const cloudRequest = useRef<AbortController | null>(null);
  useEffect(() => () => cloudRequest.current?.abort(), []);
  const validName = containerNodeNameSchema.safeParse(name);
  const issue = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async () => {
      const request = new AbortController();
      cloudRequest.current = request;
      setAuthorization(null);
      return authorizeCloudNode(name.trim(), request.signal, setAuthorization);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["node-devices"] });
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col"
      {...{
        onCloseAutoFocus: (event: Event) => {
          event.preventDefault();
          const target = trigger.isConnected ? trigger : document.getElementById("docker-compose");
          target?.focus();
        },
      }}
    >
      <DialogHeader onClose={onClose} closeLabel={t("common.close")}>
        <DialogTitle>{node("title")}</DialogTitle>
        <DialogDescription>{node(issue.data ? "saveCompose" : "description")}</DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 space-y-4">
        {issue.data ? (
          <ComposeInstructions compose={containerNodeCompose(issue.data)} />
        ) : issue.isPending && authorization ? (
          <>
            <p className="text-ui text-muted-foreground">{node("approveOnCloud")}</p>
            <p className="text-ui">
              {node("authorizationCode")}{" "}
              <code className="font-mono">{authorization.userCode}</code>
            </p>
            <Button variant="outline" asChild>
              <a
                href={authorization.verificationUriComplete}
                target="_blank"
                rel="noopener noreferrer"
              >
                {node("openCloud")}
              </a>
            </Button>
            <p role="status" className="text-ui text-muted-foreground">
              {node("awaitingApproval")}
            </p>
          </>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!issue.isPending && validName.success) issue.mutate();
            }}
          >
            <Field>
              <FieldLabel htmlFor={nameId}>{node("name")}</FieldLabel>
              <Input
                id={nameId}
                maxLength={80}
                value={name}
                disabled={issue.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            {issue.error && (
              <FormError>
                {node([`errors.${issue.error.message as "unavailable"}`, "errors.unavailable"])}
              </FormError>
            )}
            <Button type="submit" disabled={issue.isPending || !validName.success}>
              {node(issue.isPending ? "generating" : "authorizeAndGenerate")}
            </Button>
          </form>
        )}
      </DialogBody>
    </Dialog>
  );
}

function ComposeInstructions({ compose }: { compose: string }) {
  const { t } = useTranslation("settings", { keyPrefix: "devices.containerNodes" });
  const { copy, copiedText } = useCopyFeedback();
  const [copyFailed, setCopyFailed] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([compose], { type: "application/yaml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "compose.yaml";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <>
      <pre
        role="region"
        aria-label={t("configuration")}
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-8 bg-muted p-4 font-mono text-aux text-foreground"
      >
        <code>{compose}</code>
      </pre>
      {copyFailed && <FormError>{t("copyFailed")}</FormError>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={download}>
          {t("download")}
        </Button>
        {navigator.clipboard && (
          <Button type="button" onClick={() => void copy(compose).then((ok) => setCopyFailed(!ok))}>
            {t(copiedText === compose ? "copied" : "copy")}
          </Button>
        )}
      </div>
    </>
  );
}

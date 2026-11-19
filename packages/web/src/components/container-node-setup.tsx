import {
  type ContainerNode,
  type ContainerNodeGrant,
  type DevicesStatus,
  containerNodeComposeGrantSchema,
  containerNodeGrantSchema,
  containerNodeListSchema,
} from "@rome/api-types/devices";
import {
  containerNodeOrigin,
  isContainerNodeLoopback,
} from "@rome-os/node-core/container-node-address";
import { DeviceRenameDialog, messagesFor, type NodeDevicePairing } from "@rome-os/node-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { fetchJson } from "@/lib/fetch-json";
import romeNodeImage from "@/lib/rome-node-image.json";

const path = "/api/devices/container-nodes";

const deviceStatus = {
  online: "connected",
  offline: "not_connected",
  unknown: "unknown",
} as const;

function containerNodeCompose({ id, expiresAt, installToken }: ContainerNodeGrant, origin: string) {
  const projectName = `rome-node-${id.toLowerCase().replaceAll("-", "").slice(0, 20)}`;
  return {
    id,
    projectName,
    expiresAt,
    compose: `services:
  rome-node:
    image: "${romeNodeImage.image}"
    container_name: "${projectName}"
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment:
      ROME_NODE_CLOUD_URL: ${JSON.stringify(origin.replaceAll("$", () => "$$"))}
      ROME_NODE_INSTALLATION_ID: "${id}"
      ROME_NODE_INSTALL_TOKEN: "${installToken}"
    volumes:
      - state:/state
volumes:
  state:
    name: "rome-node-${id}-state"
`,
  };
}

function useContainerNodeText() {
  return useTranslation("settings", { keyPrefix: "devices.containerNodes" });
}

function ContainerNodeError({ error }: { error: Error }) {
  const { t } = useContainerNodeText();
  return (
    <FormError>{t([`errors.${error.message as "unavailable"}`, "errors.unavailable"])}</FormError>
  );
}

function useContainerNodes() {
  return useQuery<ReturnType<typeof containerNodeListSchema.parse>>({
    queryKey: ["container-nodes"],
    retry: false,
    refetchInterval: ({ state }) =>
      ["cloud_unsupported", "not_configured", "sign_in_required"].includes(
        state.error?.message ?? "",
      )
        ? false
        : 15_000,
    queryFn: async ({ signal }) =>
      containerNodeListSchema.parse(
        await fetchJson<unknown>(path, { signal, fallback: "unavailable" }),
      ),
  });
}

export function ContainerNodeSetup({
  onIssued,
}: {
  onIssued?: (grant: ContainerNodeGrant) => void;
}) {
  const { t } = useContainerNodeText();
  const query = useContainerNodes();
  return (
    <>
      <p className="text-ui text-muted-foreground">{t("description")}</p>
      {query.isPending && (
        <p role="status" className="text-ui text-muted-foreground">
          {t("loading")}
        </p>
      )}
      {query.error && <ContainerNodeError error={query.error} />}
      {query.data && (
        <PairContainerNode direct={query.data.transport === "direct"} onIssued={onIssued} />
      )}
    </>
  );
}

export function useContainerNodeCards(devices: DevicesStatus["devices"]) {
  const { t, i18n } = useContainerNodeText();
  const query = useContainerNodes();
  const client = useQueryClient();
  const [selected, setSelected] = useState<{ id: string; grant?: ContainerNodeGrant } | null>(null);
  const [renaming, setRenaming] = useState<ContainerNode | null>(null);
  const [removing, setRemoving] = useState<ContainerNode | null>(null);
  const pairingTrigger = useRef<HTMLButtonElement>(null);
  const nodes = query.data?.nodes ?? [];
  const waiting = nodes.filter((node) => node.status === "waiting" && !node.deviceId);
  const pairing = waiting.find((node) => node.id === selected?.id);
  const issuedGrant = selected?.grant;
  useEffect(() => {
    if (selected && !pairing) setSelected(null);
  }, [selected, pairing]);
  const pairings = waiting.map<NodeDevicePairing>((node) => ({
    id: node.id,
    name: node.name,
    waitingLabel: t("status.waiting"),
    onOpen: (event) => {
      pairingTrigger.current = event.currentTarget;
      setSelected({ id: node.id });
    },
    onRename: () => setRenaming(node),
    onRemove: () => setRemoving(node),
  }));

  const direct = query.data?.transport === "direct";
  const replacedIds = new Set<string>();
  const linked: DevicesStatus["devices"] = [];
  for (const { deviceId, name, status } of nodes) {
    if (!deviceId) continue;
    if (direct || status === "needs_pairing") replacedIds.add(deviceId);
    // Direct cards come from the installation list so a device poll cannot show an older state.
    if (direct && status !== "waiting" && status !== "needs_pairing") {
      linked.push({ id: deviceId, name, platform: "linux", status: deviceStatus[status] });
    }
  }
  const closePairing = () => setSelected(null);
  return {
    devices: [
      ...devices.filter(
        (device) => !replacedIds.has(device.id) && !(direct && device.installationId),
      ),
      ...linked,
    ],
    pairings,
    openIssuedPairing(grant: ContainerNodeGrant) {
      pairingTrigger.current = null;
      setSelected({ id: grant.id, grant });
    },
    dialogs: (
      <>
        {pairing && (
          <Dialog
            open
            onClose={closePairing}
            className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col"
            {...{
              onCloseAutoFocus: (event: Event) => {
                if (pairingTrigger.current?.isConnected) {
                  event.preventDefault();
                  pairingTrigger.current.focus();
                }
              },
            }}
          >
            <DialogHeader onClose={closePairing} closeLabel={t("close")}>
              <DialogTitle>{pairing.name}</DialogTitle>
              <DialogDescription>{t("status.waiting")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="min-h-0 space-y-4">
              {issuedGrant?.origin ? (
                <ComposeInstructions
                  grant={containerNodeCompose(issuedGrant, issuedGrant.origin)}
                />
              ) : (
                <SavedCompose id={pairing.id} />
              )}
            </DialogBody>
          </Dialog>
        )}
        {renaming && (
          <DeviceRenameDialog
            currentName={renaming.name}
            rename={async (name) => {
              try {
                await fetchJson<void>(`${path}/${renaming.id}`, {
                  method: "PATCH",
                  json: { name },
                  fallback: "unavailable",
                });
                void client.invalidateQueries({ queryKey: ["container-nodes"] });
                return null;
              } catch (error) {
                if (error instanceof Error && error.message === "invalid_device_name")
                  return "invalid_device_name";
                if (error instanceof Error && error.message === "node_not_found")
                  return "device_not_found";
                return "unavailable";
              }
            }}
            m={messagesFor(i18n.language)}
            onClose={() => setRenaming(null)}
          />
        )}
        {removing && <RemoveContainerNode node={removing} onClose={() => setRemoving(null)} />}
      </>
    ),
  };
}

function SavedCompose({ id }: { id: string }) {
  const { t } = useContainerNodeText();
  const query = useQuery({
    queryKey: ["container-node-compose", id],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) =>
      containerNodeComposeGrantSchema.parse(
        await fetchJson<unknown>(`${path}/${id}/compose`, { signal, fallback: "unavailable" }),
      ),
  });
  if (query.error) return <ContainerNodeError error={query.error} />;
  if (!query.data)
    return (
      <p role="status" className="text-ui text-muted-foreground">
        {t("loadingCompose")}
      </p>
    );
  return <ComposeInstructions grant={containerNodeCompose(query.data, query.data.origin)} />;
}

function deploymentOrigin(address: string): string | null {
  try {
    return containerNodeOrigin(address.trim());
  } catch {
    return null;
  }
}

function RemoveContainerNode({ node, onClose }: { node: ContainerNode; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      fetchJson<void>(`${path}/${node.id}`, { method: "DELETE", fallback: "unavailable" }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["container-nodes"] });
    },
    onSuccess: onClose,
  });

  return (
    <RomeConfirmDialog
      open
      destructive
      title={t("devices.containerNodes.removeTitle", { name: node.name })}
      description={t("devices.containerNodes.removeDescription")}
      confirmLabel={t("common.remove")}
      confirmDisabled={remove.isPending}
      onCancel={onClose}
      onConfirm={() => remove.mutate()}
    >
      {remove.error && <ContainerNodeError error={remove.error} />}
    </RomeConfirmDialog>
  );
}

function PairContainerNode({
  direct,
  onIssued,
}: {
  direct: boolean;
  onIssued?: (grant: ContainerNodeGrant) => void;
}) {
  const { t } = useContainerNodeText();
  const nameId = useId();
  const addressId = useId();
  const addressHintId = `${addressId}-hint`;
  const client = useQueryClient();
  const [name, setName] = useState(t("defaultName"));
  const [editedAddress, setEditedAddress] = useState<string>();
  const [addressRejected, setAddressRejected] = useState(false);
  const address = editedAddress ?? window.location.origin;
  const [installationId, setInstallationId] = useState<string>();
  const issue = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async (id?: string) => {
      const grant = containerNodeGrantSchema.parse(
        await fetchJson<unknown>(id ? `${path}/${id}/pairing` : path, {
          method: "POST",
          json: { ...(id ? {} : { name: name.trim() }), ...(direct && origin ? { origin } : {}) },
          fallback: "unavailable",
        }),
      );
      const issuedOrigin = grant.origin ?? origin;
      if (!issuedOrigin) throw new Error("unavailable");
      return { ...grant, origin: issuedOrigin };
    },
    onSettled: (grant) => {
      const refresh = client.invalidateQueries({ queryKey: ["container-nodes"] });
      if (grant && onIssued) void refresh.then(() => onIssued(grant));
    },
    onSuccess: (data) => setInstallationId(data.id),
  });
  const origin: string | null = issue.data?.origin ?? (direct ? deploymentOrigin(address) : null);
  const originUnavailable = direct && !origin;
  const addressInvalid = originUnavailable && addressRejected;
  const loopback = origin && isContainerNodeLoopback(new URL(origin).hostname.replace(/\.$/, ""));
  const addressHint = originUnavailable
    ? t("originUnavailable")
    : loopback
      ? t("loopbackHint")
      : null;
  const configuration = issue.data && origin ? containerNodeCompose(issue.data, origin) : null;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const needsGrant = !issue.data || Date.parse(issue.data.expiresAt) <= Date.now();
        if (!needsGrant || issue.isPending || !name.trim()) return;
        if (originUnavailable) {
          setAddressRejected(true);
          return;
        }
        issue.mutate(installationId);
      }}
    >
      {!installationId && (
        <Field>
          <FieldLabel htmlFor={nameId}>{t("name")}</FieldLabel>
          <Input
            id={nameId}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      )}
      {direct && !issue.data?.origin && (
        <Field>
          <FieldLabel htmlFor={addressId}>{t("address")}</FieldLabel>
          <Input
            id={addressId}
            type="url"
            value={address}
            aria-invalid={addressInvalid || undefined}
            aria-describedby={addressHint ? addressHintId : undefined}
            disabled={issue.isPending}
            onChange={(event) => {
              setEditedAddress(event.target.value);
              setAddressRejected(false);
            }}
          />
          {addressHint &&
            (addressInvalid ? (
              <FieldError id={addressHintId} errors={[addressHint]} />
            ) : (
              <FieldDescription id={addressHintId}>{addressHint}</FieldDescription>
            ))}
        </Field>
      )}
      {issue.error && <ContainerNodeError error={issue.error} />}
      {configuration && (
        <ComposeInstructions
          key={configuration.expiresAt}
          grant={configuration}
          replacing={Boolean(issue.variables)}
          canRegenerate
        />
      )}
      {!issue.data && (
        <Button type="submit" disabled={issue.isPending || !name.trim()}>
          {t(issue.isPending ? "generating" : "generate")}
        </Button>
      )}
    </form>
  );
}

function ComposeInstructions({
  grant,
  replacing = false,
  canRegenerate = false,
}: {
  grant: ReturnType<typeof containerNodeCompose>;
  replacing?: boolean;
  canRegenerate?: boolean;
}) {
  const { t, i18n } = useContainerNodeText();
  const { copy, copiedText } = useCopyFeedback();
  const [copyFailed, setCopyFailed] = useState(false);
  const deadline = Date.parse(grant.expiresAt);
  const [expired, setExpired] = useState(deadline <= Date.now());
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([grant.compose], { type: "application/yaml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "compose.yaml";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <>
      <div className="space-y-2 text-ui text-muted-foreground">
        <p>
          {t(replacing ? "replaceProject" : "projectName")}{" "}
          <code className="select-all break-all font-mono text-foreground">
            {grant.projectName}
          </code>
        </p>
        <p>
          {expired
            ? t("expired")
            : t("expires", {
                time: new Date(deadline).toLocaleTimeString(i18n.language, {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
        </p>
        {copyFailed && <FormError>{t("copyFailed")}</FormError>}
      </div>
      <pre
        role="region"
        aria-label={t("configuration")}
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-8 bg-muted p-4 font-mono text-aux text-foreground"
      >
        <code>{grant.compose}</code>
      </pre>
      <div className="flex flex-wrap gap-2">
        {expired ? (
          canRegenerate && <Button type="submit">{t("newCompose")}</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={download}>
              {t("download")}
            </Button>
            {navigator.clipboard && (
              <Button
                type="button"
                onClick={() => void copy(grant.compose).then((ok) => setCopyFailed(!ok))}
              >
                {t(copiedText === grant.compose ? "copied" : "copy")}
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}

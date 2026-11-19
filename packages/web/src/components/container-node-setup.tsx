import {
  type ContainerNode,
  type ContainerNodeGrant,
  containerNodeGrantSchema,
  containerNodeListSchema,
} from "@rome/api-types/devices";
import {
  containerNodeOrigin,
  isContainerNodeLoopback,
} from "@rome-os/node-core/container-node-address";
import { Section, SectionHeader, SectionHeading, SectionTitle } from "@rome-os/ui/page";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { StatusIndicator } from "@/lib/connection-status";
import { fetchJson } from "@/lib/fetch-json";
import romeNodeImage from "@/lib/rome-node-image.json";

const path = "/api/devices/container-nodes";

function containerNodeCompose({ id, expiresAt, installToken }: ContainerNodeGrant, origin: string) {
  const projectName = `rome-node-${id.toLowerCase().replaceAll("-", "").slice(0, 20)}`;
  const { hostname } = new URL(origin);
  const networkMode = isContainerNodeLoopback(hostname) ? "\n    network_mode: host" : "";
  // Keep the name used by the browser so the host's reverse proxy can route the request.
  const loopbackAlias = hostname.endsWith(".localhost")
    ? `\n    extra_hosts:\n      ${JSON.stringify(hostname)}: "127.0.0.1"`
    : "";
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
    security_opt: ["no-new-privileges:true"]${networkMode}${loopbackAlias}
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

export function ContainerNodeSetup() {
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
      {query.data && <PairContainerNode direct={query.data.transport === "direct"} />}
    </>
  );
}

export function ContainerNodeInstallations() {
  const { t } = useContainerNodeText();
  const query = useContainerNodes();
  const [pairing, setPairing] = useState<ContainerNode | null>(null);
  const [removing, setRemoving] = useState<ContainerNode | null>(null);
  const installations = query.data?.nodes.filter((node) => !node.deviceId) ?? [];
  if (!installations.length && !pairing && !removing) return null;
  return (
    <Section aria-labelledby="container-node-installations-title">
      <SectionHeader>
        <SectionHeading>
          <SectionTitle id="container-node-installations-title">{t("list")}</SectionTitle>
        </SectionHeading>
      </SectionHeader>
      <Card>
        <CardContent>
          <ul className="divide-y divide-border">
            {installations.map((node) => (
              <li
                key={node.id}
                className="flex flex-wrap items-center justify-between gap-3 not-first:pt-3 not-last:pb-3"
              >
                <div className="min-w-0">
                  <p className="break-words text-ui">{node.name}</p>
                  <StatusIndicator
                    status={{
                      label: t(`status.${node.status}`),
                      tone: node.status === "needs_pairing" ? "attention" : "muted",
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPairing(node)}>
                    {t(node.status === "waiting" ? "newCompose" : "repair")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(node)}>
                    {t("remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {pairing && (
        <Dialog open onClose={() => setPairing(null)}>
          <DialogHeader onClose={() => setPairing(null)} closeLabel={t("close")}>
            <DialogTitle>{t(pairing.status === "waiting" ? "newCompose" : "repair")}</DialogTitle>
            <DialogDescription>{pairing.name}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <PairContainerNode node={pairing} direct={query.data?.transport === "direct"} />
          </DialogBody>
        </Dialog>
      )}
      {removing && <RemoveContainerNode node={removing} onClose={() => setRemoving(null)} />}
    </Section>
  );
}

function deploymentOrigin(address: string): string | null {
  try {
    return containerNodeOrigin(address.trim());
  } catch {
    return null;
  }
}

function RemoveContainerNode({ node, onClose }: { node: ContainerNode; onClose: () => void }) {
  const { t } = useContainerNodeText();
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
      title={t("removeTitle", { name: node.name })}
      description={t("removeDescription")}
      confirmLabel={t("remove")}
      confirmDisabled={remove.isPending}
      onCancel={onClose}
      onConfirm={() => remove.mutate()}
    >
      {remove.error && <ContainerNodeError error={remove.error} />}
    </RomeConfirmDialog>
  );
}

function PairContainerNode({ node, direct }: { node?: ContainerNode; direct: boolean }) {
  const { t } = useContainerNodeText();
  const nameId = useId();
  const addressId = useId();
  const client = useQueryClient();
  const [name, setName] = useState(node?.name ?? t("defaultName"));
  const [address, setAddress] = useState(() => window.location.origin);
  const [installationId, setInstallationId] = useState(node?.id);
  const issue = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async (id?: string) => {
      const grant = containerNodeGrantSchema.parse(
        await fetchJson<unknown>(id ? `${path}/${id}/pairing` : path, {
          method: "POST",
          json: id ? {} : { name: name.trim() },
          fallback: "unavailable",
        }),
      );
      if (!direct && !grant.origin) throw new Error("unavailable");
      return grant;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["container-nodes"] });
    },
    onSuccess: (data) => setInstallationId(data.id),
  });
  const origin = issue.data?.origin ?? (direct ? deploymentOrigin(address) : null);
  const originUnavailable = direct && !origin;
  const configuration = issue.data && origin ? containerNodeCompose(issue.data, origin) : null;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const needsGrant = !issue.data || Date.parse(issue.data.expiresAt) <= Date.now();
        if (needsGrant && !originUnavailable && !issue.isPending && name.trim())
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
            aria-invalid={originUnavailable || undefined}
            disabled={issue.isPending}
            onChange={(event) => setAddress(event.target.value)}
          />
          {originUnavailable && <FormError>{t("originUnavailable")}</FormError>}
        </Field>
      )}
      {issue.error && <ContainerNodeError error={issue.error} />}
      {configuration && (
        <ComposeInstructions
          key={configuration.expiresAt}
          grant={configuration}
          replacing={Boolean(issue.variables)}
          onDone={
            node
              ? undefined
              : () => {
                  issue.reset();
                  setInstallationId(undefined);
                  setName(t("defaultName"));
                }
          }
        />
      )}
      {!issue.data && (
        <Button type="submit" disabled={originUnavailable || issue.isPending || !name.trim()}>
          {t(issue.isPending ? "generating" : "generate")}
        </Button>
      )}
    </form>
  );
}

function ComposeInstructions({
  grant,
  replacing,
  onDone,
}: {
  grant: ReturnType<typeof containerNodeCompose>;
  replacing: boolean;
  onDone?: () => void;
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
          <Button type="submit">{t("newCompose")}</Button>
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
        {onDone && (
          <Button type="button" variant="ghost" onClick={onDone}>
            {t("addAnother")}
          </Button>
        )}
      </div>
    </>
  );
}

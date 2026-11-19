import {
  type LanNode,
  type LanNodeGrant,
  lanNodeGrantSchema,
  lanNodeListSchema,
  lanSwitchStatusSchema,
} from "@rome/api-types/devices";
import {
  Section,
  SectionActions,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { StatusIndicator } from "@/lib/connection-status";
import { fetchJson } from "@/lib/fetch-json";
import romeNodeImage from "@/lib/rome-node-image.json";
import { shareableOrigin } from "@/lib/shareable-origin";

const path = "/api/devices/lan-nodes";
const vendors = ["ugos", "synology", "qnap"] as const;
type Vendor = (typeof vendors)[number];

function lanNodeCompose({ id, expiresAt, installToken }: LanNodeGrant, origin: string) {
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

function useLanText() {
  return useTranslation("settings", { keyPrefix: "devices.lan" });
}

function LanError({ error }: { error: Error }) {
  const { t } = useLanText();
  return (
    <FormError>{t([`errors.${error.message as "unavailable"}`, "errors.unavailable"])}</FormError>
  );
}

function installerUnavailable(error: Error | null) {
  return error?.message === "cloud_unsupported" || error?.message === "not_configured";
}

export function LanNodesSection({ deviceHref }: { deviceHref: (id: string) => string }) {
  const { t } = useLanText();
  const title = useId();
  const query = useQuery<ReturnType<typeof lanNodeListSchema.parse>>({
    queryKey: ["lan-nodes"],
    retry: false,
    refetchInterval: ({ state }) => (installerUnavailable(state.error) ? false : 15_000),
    queryFn: async ({ signal }) =>
      lanNodeListSchema.parse(await fetchJson<unknown>(path, { signal, fallback: "unavailable" })),
  });
  const [pairing, setPairing] = useState<{ node?: LanNode } | null>(null);
  const [checking, setChecking] = useState<LanNode | null>(null);
  const [removing, setRemoving] = useState<LanNode | null>(null);
  if (query.isPending || installerUnavailable(query.error)) return null;
  return (
    <Section aria-labelledby={title}>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle id={title}>{t("title")}</SectionTitle>
          <SectionDescription>{t("description")}</SectionDescription>
        </SectionHeading>
        <SectionActions>
          <Button size="sm" disabled={!query.isSuccess} onClick={() => setPairing({})}>
            {t("add")}
          </Button>
        </SectionActions>
      </SectionHeader>
      {query.error ? (
        <LanError error={query.error} />
      ) : (
        query.data?.nodes.map((node) => (
          <Card key={node.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-ui">{node.name}</p>
                <StatusIndicator
                  status={{
                    label: t(`status.${node.status}`),
                    tone:
                      node.status === "online"
                        ? "success"
                        : node.status === "needs_pairing"
                          ? "attention"
                          : "muted",
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {node.deviceId && (
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={deviceHref(node.deviceId)}>{t("manage")}</Link>
                  </Button>
                )}
                {node.status === "online" && (
                  <Button variant="outline" size="sm" onClick={() => setChecking(node)}>
                    {t("switch.title")}
                  </Button>
                )}
                {(node.status === "waiting" || node.status === "needs_pairing") && (
                  <Button variant="outline" size="sm" onClick={() => setPairing({ node })}>
                    {t(node.status === "waiting" ? "newCompose" : "repair")}
                  </Button>
                )}
                {!node.deviceId && (
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(node)}>
                    {t("remove")}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}
      {pairing && query.data && (
        <PairLanNode
          node={pairing.node}
          direct={query.data.transport === "direct"}
          onClose={() => setPairing(null)}
        />
      )}
      {checking && <CheckLanSwitch node={checking} onClose={() => setChecking(null)} />}
      {removing && <RemoveLanNode node={removing} onClose={() => setRemoving(null)} />}
    </Section>
  );
}

function RemoveLanNode({ node, onClose }: { node: LanNode; onClose: () => void }) {
  const { t } = useLanText();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      fetchJson<void>(`${path}/${node.id}`, { method: "DELETE", fallback: "unavailable" }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["lan-nodes"] });
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
      {remove.error && <LanError error={remove.error} />}
    </RomeConfirmDialog>
  );
}

function PairLanNode({
  node,
  direct,
  onClose,
}: {
  node?: LanNode;
  direct: boolean;
  onClose: () => void;
}) {
  const { t } = useLanText();
  const nameId = useId();
  const vendorId = useId();
  const client = useQueryClient();
  const [vendor, setVendor] = useState<Vendor>("ugos");
  const [name, setName] = useState(node?.name ?? t("defaultName"));
  const [installationId, setInstallationId] = useState(node?.id);
  const dashboardOrigin = window.location.protocol === "https:" ? shareableOrigin() : null;
  const needsHttps = direct && !dashboardOrigin;
  const issue = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async (id?: string) => {
      const grant = lanNodeGrantSchema.parse(
        await fetchJson<unknown>(id ? `${path}/${id}/pairing` : path, {
          method: "POST",
          json: id ? {} : { name: name.trim() },
          fallback: "unavailable",
        }),
      );
      const origin = grant.origin ?? dashboardOrigin;
      if (!origin) throw new Error("unavailable");
      return lanNodeCompose(grant, origin);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["lan-nodes"] });
    },
    onSuccess: (data) => setInstallationId(data.id),
  });
  const title = !node ? t("add") : node.status === "waiting" ? t("newCompose") : t("repair");
  return (
    <Dialog open onClose={onClose} className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader onClose={onClose} closeLabel={t("close")}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("setupDescription")}</DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!needsHttps) issue.mutate(installationId);
        }}
      >
        <DialogBody className="space-y-4">
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
          <Field>
            <FieldLabel htmlFor={vendorId}>{t("vendorLabel")}</FieldLabel>
            <Select value={vendor} onValueChange={(value) => setVendor(value as Vendor)}>
              <SelectTrigger id={vendorId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`vendors.${value}.name`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-ui text-muted-foreground">{t(`vendors.${vendor}.guide`)}</p>
          {needsHttps && <FormError>{t("openHttps")}</FormError>}
          {issue.error && <LanError error={issue.error} />}
        </DialogBody>
        {issue.data ? (
          <ComposeInstructions
            key={issue.data.expiresAt}
            grant={issue.data}
            replacing={Boolean(issue.variables)}
            onClose={onClose}
          />
        ) : (
          <DialogFooter>
            <Button type="submit" disabled={needsHttps || issue.isPending || !name.trim()}>
              {t(issue.isPending ? "generating" : "generate")}
            </Button>
          </DialogFooter>
        )}
      </form>
    </Dialog>
  );
}

function ComposeInstructions({
  grant,
  replacing,
  onClose,
}: {
  grant: ReturnType<typeof lanNodeCompose>;
  replacing: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useLanText();
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
      <DialogBody className="space-y-2 pt-0 text-ui text-muted-foreground">
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
        <p>{t("returnToRome")}</p>
        {copyFailed && <FormError>{t("copyFailed")}</FormError>}
      </DialogBody>
      <DialogFooter className="flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("close")}
        </Button>
        {expired ? (
          <Button type="submit">{t("newCompose")}</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={download}>
              {t("download")}
            </Button>
            <Button
              type="button"
              onClick={() => void copy(grant.compose).then((ok) => setCopyFailed(!ok))}
            >
              {t(copiedText === grant.compose ? "copied" : "copy")}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function CheckLanSwitch({ node, onClose }: { node: LanNode; onClose: () => void }) {
  const { t } = useLanText();
  const id = useId();
  const [address, setAddress] = useState("");
  const check = useMutation({
    retry: false,
    mutationFn: async () =>
      lanSwitchStatusSchema.parse(
        await fetchJson<unknown>(`${path}/${node.id}/switch-status`, {
          method: "POST",
          json: { address: address.trim() },
          fallback: "unavailable",
        }),
      ),
  });
  return (
    <Dialog open onClose={onClose} size="sm">
      <DialogHeader onClose={onClose} closeLabel={t("close")}>
        <DialogTitle>{t("switch.title")}</DialogTitle>
        <DialogDescription>{t("switch.description", { name: node.name })}</DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          check.mutate();
        }}
      >
        <DialogBody className="space-y-3">
          <Field>
            <FieldLabel htmlFor={id}>{t("switch.address")}</FieldLabel>
            <Input
              id={id}
              maxLength={15}
              placeholder="192.168.1.40"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                check.reset();
              }}
              disabled={check.isPending}
            />
          </Field>
          {check.error && <LanError error={check.error} />}
          {check.data && (
            <p role="status" className="text-ui">
              {t(check.data.on ? "switch.on" : "switch.off")}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="submit" disabled={check.isPending || !address.trim()}>
            {t(check.isPending ? "switch.checking" : "switch.submit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

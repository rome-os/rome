import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AppConnectionPolicies,
  DocumentAccessOptions,
} from "@rome/api-types/app-connection-access";
import { useAppsList } from "@/hooks/use-apps";
import { fetchJson } from "@/lib/fetch-json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AppDocumentAccess() {
  const { t } = useTranslation("settings");
  const copy = (key: string) => t(`appDocuments.${key}`);
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [cursor, setCursor] = useState(0);
  const apps = useAppsList({ enabled: open });
  const queries = useQueryClient();
  const options = useQuery({
    queryKey: ["app-document-options", appId, cursor],
    enabled: open && !!appId,
    queryFn: ({ signal }) =>
      fetchJson<DocumentAccessOptions>(
        `/api/app-connection-access/${encodeURIComponent(appId)}/documents?cursor=${cursor}&limit=50`,
        { signal, fallback: copy("loadFailed") },
      ),
  });
  const policies = useQuery({
    queryKey: ["app-connection-policies", appId],
    enabled: open && !!appId,
    queryFn: ({ signal }) =>
      fetchJson<AppConnectionPolicies>(`/api/app-connection-access/${encodeURIComponent(appId)}`, {
        signal,
        fallback: copy("loadFailed"),
      }),
  });
  const selected = options.data?.connections.find((entry) => entry.connectionId === connectionId);
  const mutation = useMutation({
    mutationFn: (input: {
      method: "PUT" | "DELETE";
      appId: string;
      connectionId: string;
      identity: string;
      operation: string;
      documentId?: string;
    }) => {
      const path = [input.appId, input.connectionId, input.identity, input.operation]
        .map(encodeURIComponent)
        .join("/");
      return fetchJson<void>(`/api/app-connection-access/${path}`, {
        method: input.method,
        fallback: copy("saveFailed"),
        ...(input.method === "PUT"
          ? {
              json: {
                approval: "not_required",
                constraints: [{ inputPointer: "/documentId", allowedValues: [input.documentId] }],
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              },
            }
          : {}),
      });
    },
    onSuccess: async (_value, input) => {
      await queries.invalidateQueries({ queryKey: ["app-connection-policies", input.appId] });
    },
  });
  const loading = options.isFetching || policies.isFetching;
  const busy = mutation.isPending;
  const error = apps.error ?? options.error ?? policies.error ?? mutation.error;
  const valid = /^[a-zA-Z0-9]{1,128}$/.test(documentId);
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <Button variant="outline" onClick={() => setOpen(!open)}>
        {copy("title")}
      </Button>
      {open ? (
        <div className="space-y-3">
          <p className="text-ui text-muted-foreground">{copy("scope")}</p>
          <Select
            value={appId}
            disabled={busy}
            onValueChange={(value) => {
              setAppId(value);
              setConnectionId("");
              setDocumentId("");
              setCursor(0);
              mutation.reset();
            }}
          >
            <SelectTrigger aria-label={copy("app")}>
              <SelectValue placeholder={copy("app")} />
            </SelectTrigger>
            <SelectContent>
              {apps.apps
                ?.filter((app) => app.isEnabled)
                .map((app) => (
                  <SelectItem key={app.id} value={app.id}>
                    {app.displayName} · {app.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {appId ? (
            <>
              <Select
                value={connectionId}
                disabled={busy || loading}
                onValueChange={(value) => {
                  setConnectionId(value);
                  mutation.reset();
                }}
              >
                <SelectTrigger aria-label={copy("bot")}>
                  <SelectValue placeholder={copy("bot")} />
                </SelectTrigger>
                <SelectContent>
                  {options.data?.connections.map((entry) => (
                    <SelectItem key={entry.connectionId} value={entry.connectionId}>
                      {entry.label} · {entry.connectionId.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {options.data?.nextCursor !== undefined || cursor > 0 ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || cursor === 0}
                    onClick={() => {
                      setCursor(Math.max(0, cursor - 50));
                      setConnectionId("");
                    }}
                  >
                    {copy("previous")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || options.data?.nextCursor === undefined}
                    onClick={() => {
                      setCursor(options.data!.nextCursor!);
                      setConnectionId("");
                    }}
                  >
                    {copy("next")}
                  </Button>
                </div>
              ) : null}
              {selected ? (
                <>
                  {!selected.supported ? <p role="status">{copy("unsupported")}</p> : null}
                  {!selected.authorized ? <p role="status">{copy("disconnected")}</p> : null}
                  <p className="text-ui text-muted-foreground">
                    {copy("providerScope")} <code>{selected.scope}</code>
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {selected.consoles.map((console) => (
                      <a
                        key={console.brand}
                        href={console.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-ui underline"
                      >
                        {console.brand === "lark" ? copy("larkConsole") : copy("feishuConsole")}
                      </a>
                    ))}
                  </div>
                  <p className="text-ui text-muted-foreground">{copy("providerGuidance")}</p>
                  <Input
                    aria-label={copy("document")}
                    placeholder={copy("document")}
                    value={documentId}
                    disabled={busy}
                    onChange={(event) => {
                      setDocumentId(event.target.value.trim());
                      mutation.reset();
                    }}
                  />
                  <p className="text-ui text-muted-foreground">{copy("replaceWarning")}</p>
                  <Button
                    disabled={
                      busy ||
                      loading ||
                      !!options.error ||
                      !!policies.error ||
                      !valid ||
                      !selected.supported ||
                      !selected.authorized
                    }
                    onClick={() =>
                      mutation.mutate({ method: "PUT", appId, ...selected, documentId })
                    }
                  >
                    {copy("allow")}
                  </Button>
                </>
              ) : null}
              {loading ? <p role="status">{copy("loading")}</p> : null}
              {policies.data?.policies
                .filter((policy) => policy.operation === "feishu.document.read")
                .map((policy) => (
                  <div
                    key={`${policy.connectionId}:${policy.identity}`}
                    className="space-y-1 border-t border-border pt-3 text-ui"
                  >
                    <p>
                      {policy.connectionId} ·{" "}
                      {policy.constraints
                        .find((item) => item.inputPointer === "/documentId")
                        ?.allowedValues.join(", ") ?? copy("allDocuments")}
                    </p>
                    <p className="text-muted-foreground">
                      {policy.grantStatus === "current" &&
                      (!policy.expiresAt || Date.parse(policy.expiresAt) > Date.now())
                        ? copy("active")
                        : copy("inactive")}
                      {policy.expiresAt ? ` · ${policy.expiresAt}` : ""}
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => mutation.mutate({ method: "DELETE", ...policy })}
                    >
                      {copy("revoke")}
                    </Button>
                  </div>
                ))}
            </>
          ) : null}
          {mutation.isSuccess ? <p role="status">{copy("saved")}</p> : null}
          {error ? <p role="alert">{error.message}</p> : null}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void options.refetch();
              void policies.refetch();
              apps.retry();
            }}
          >
            {copy("refresh")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
